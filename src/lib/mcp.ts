import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { destinations, interests } from "./catalog";
import { db, packages, rateLimit, type User } from "./db";
import {
  bearerChallenge,
  verifyAccessToken,
  type AccessGrant,
  type OAuthScope,
} from "./oauth";
import { previewCatalogPlan, requestBooking, saveCatalogPlan } from "./travel";
import { AppError, dateForDay, money } from "./validation";
import { itineraryWidgetHtml } from "../generated/itinerary-widget";

export const widgetUri = "ui://sanaa/itinerary-v1.html";
export const widgetMimeType = "text/html;profile=mcp-app";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Max-Age": "600",
};
export const withCors = (response: Response) => {
  for (const [key, value] of Object.entries(corsHeaders))
    response.headers.set(key, value);
  return response;
};

const instructions =
  "Sanaa Kenya plans illustrative Kenya trips from a curated catalog. Call search_journeys to get journey ids, then plan_journey to show a priced day-by-day itinerary card. Only call save_journey or request_quote when the user explicitly asks. Estimates are illustrative, not availability or bookings; nothing is charged through this app.";

class ScopeError extends Error {
  constructor(public scope: OAuthScope) {
    super(
      `This action needs the ${scope} permission. Reconnect the app to grant it.`,
    );
  }
}
type Extra = { authInfo?: { extra?: Record<string, unknown> } };
function account(extra: Extra, scope: OAuthScope): User {
  const grant = extra.authInfo?.extra?.grant as AccessGrant | undefined;
  if (!grant)
    throw new AppError("Connect your Sanaa Kenya account first.", 401);
  if (!grant.scopes.includes(scope)) throw new ScopeError(scope);
  return grant.user;
}
function text(value: string): CallToolResult["content"] {
  return [{ type: "text", text: value }];
}
function failure(error: unknown): CallToolResult {
  if (error instanceof ScopeError)
    return {
      isError: true,
      content: text(error.message),
      _meta: {
        "mcp/www_authenticate": [
          bearerChallenge("insufficient_scope", error.message, error.scope),
        ],
      },
    };
  if (error instanceof z.ZodError)
    return {
      isError: true,
      content: text(error.issues.map((issue) => issue.message).join(" ")),
    };
  if (error instanceof AppError)
    return { isError: true, content: text(error.message) };
  console.error("MCP tool failed", error);
  return {
    isError: true,
    content: text(
      "Something went wrong on the server. Nothing was saved or booked.",
    ),
  };
}
async function run(work: () => CallToolResult | Promise<CallToolResult>) {
  try {
    return await work();
  } catch (error) {
    return failure(error);
  }
}

const journeyInput = {
  packageId: z
    .string()
    .max(60)
    .describe(
      "Journey id returned by search_journeys, for example wild-heart.",
    ),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe(
      "Arrival day in YYYY-MM-DD; the journey's fixed length sets the end date.",
    ),
  partySize: z.number().int().min(1).max(12).describe("Travellers, 1 to 12."),
  budget: z
    .number()
    .min(100)
    .max(1000000)
    .describe("Total budget for the whole party in the chosen currency."),
  currency: z.enum(["USD", "KES"]),
  interests: z
    .array(z.enum(interests as [string, ...string[]]))
    .min(1)
    .max(8)
    .describe(`One or more of: ${interests.join(", ")}.`),
};
type JourneyInput = {
  packageId: string;
  startDate: string;
  partySize: number;
  budget: number;
  currency: "USD" | "KES";
  interests: string[];
};
function preferencesFor(input: JourneyInput) {
  const journey = packages().find((item) => item.id === input.packageId);
  if (!journey)
    throw new AppError("That journey is not currently offered.", 404);
  return {
    startDate: input.startDate,
    endDate: dateForDay(input.startDate, journey.days - 1),
    partySize: input.partySize,
    budget: input.budget,
    currency: input.currency,
    interests: input.interests,
  };
}

type TripRow = {
  id: string;
  itinerary: string;
  preferences: string;
  created_at: string;
  booking_id: string | null;
  booking_status: string | null;
  quote_amount: number | null;
  quote_currency: string | null;
  quote_expires: string | null;
};
function userTrips(userId: string) {
  return (
    db()
      .prepare(
        "SELECT p.id,p.itinerary,p.preferences,p.created_at,b.id booking_id,b.status booking_status,b.quote_amount,b.quote_currency,b.quote_expires FROM plans p LEFT JOIN bookings b ON b.plan_id=p.id AND b.user_id=p.user_id WHERE p.user_id=? ORDER BY p.created_at DESC LIMIT 20",
      )
      .all(userId) as TripRow[]
  ).map((row) => {
    const itinerary = JSON.parse(row.itinerary);
    const preferences = JSON.parse(row.preferences);
    return {
      planId: row.id,
      title: itinerary.title as string,
      startDate: preferences.startDate as string,
      endDate: preferences.endDate as string,
      partySize: preferences.partySize as number,
      estimate: itinerary.estimate as { amount: number; currency: string },
      status: row.booking_status ?? "saved",
      bookingId: row.booking_id,
      quote:
        row.quote_amount && row.quote_currency
          ? {
              amount: row.quote_amount / 100,
              currency: row.quote_currency,
              expires: row.quote_expires,
            }
          : null,
    };
  });
}

export function createMcpServer() {
  const server = new McpServer(
    { name: "sanaa-kenya", title: "Sanaa Kenya", version: "1.0.0" },
    { instructions },
  );

  server.registerResource(
    "itinerary-widget",
    widgetUri,
    {
      title: "Itinerary card",
      description: "Day-by-day itinerary with save and quote actions.",
      mimeType: widgetMimeType,
    },
    async () => ({
      contents: [
        {
          uri: widgetUri,
          mimeType: widgetMimeType,
          text: itineraryWidgetHtml,
          _meta: {
            ui: {
              prefersBorder: true,
              csp: { resourceDomains: ["https://images.unsplash.com"] },
            },
          },
        },
      ],
    }),
  );

  server.registerTool(
    "get_profile",
    {
      title: "Get connected profile",
      description:
        "Return the Sanaa Kenya profile represented by this connection. The opaque id is stable across token refresh and reconnection.",
      inputSchema: {},
      outputSchema: {
        id: z.string().min(1),
        name: z.string().optional(),
        email: z.string().optional(),
        nickname: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: { "openai/profile": true },
    },
    (_args, extra) =>
      run(() => {
        const user = account(extra, "trips:read");
        const profile = {
          id: user.id,
          name: user.name,
          email: user.email,
          nickname: `${user.name} · Sanaa Kenya`,
        };
        return {
          structuredContent: profile,
          content: text(JSON.stringify(profile)),
        };
      }),
  );

  server.registerTool(
    "search_journeys",
    {
      title: "Search curated journeys",
      description:
        "Use this when the user wants Kenya trip ideas. Returns the agency's curated journeys (id, length, route) and destination daily rates. Call before plan_journey.",
      inputSchema: {
        interest: z
          .enum(interests as [string, ...string[]])
          .optional()
          .describe(
            "Only journeys visiting a destination that suits this interest.",
          ),
        maxDays: z.number().int().min(2).max(14).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Searching journeys…",
        "openai/toolInvocation/invoked": "Found journeys",
      },
    },
    ({ interest, maxDays }, extra) =>
      run(() => {
        account(extra, "trips:read");
        const journeys = packages()
          .filter((p) => !maxDays || p.days <= maxDays)
          .filter(
            (p) =>
              !interest ||
              p.route.some((id) =>
                destinations
                  .find((d) => d.id === id)
                  ?.interests.includes(interest),
              ),
          )
          .map((p) => ({
            id: p.id,
            name: p.name,
            route: p.subtitle,
            days: p.days,
            tag: p.tag,
            description: p.description,
          }));
        const places = destinations.map((d) => ({
          id: d.id,
          name: d.name,
          region: d.region,
          interests: d.interests,
          dailyUsdPerPerson: d.dailyUsd,
        }));
        return {
          structuredContent: { journeys, destinations: places },
          content: text(
            journeys.length
              ? `Found ${journeys.length} journeys: ${journeys.map((j) => `${j.name} (${j.id}, ${j.days} days)`).join("; ")}.`
              : "No curated journey matches those filters.",
          ),
        };
      }),
  );

  server.registerTool(
    "plan_journey",
    {
      title: "Plan a journey",
      description:
        "Build a server-validated, day-by-day itinerary and illustrative price for a curated journey, and show it as an itinerary card. Does not save or book anything.",
      inputSchema: journeyInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: widgetUri },
        "openai/toolInvocation/invoking": "Planning your journey…",
        "openai/toolInvocation/invoked": "Itinerary ready",
      },
    },
    (input, extra) =>
      run(() => {
        account(extra, "trips:read");
        const preview = previewCatalogPlan(
          input.packageId,
          preferencesFor(input),
        );
        const { estimate } = preview.itinerary;
        return {
          structuredContent: {
            packageId: input.packageId,
            journeyName: preview.journey.name,
            route: preview.journey.subtitle,
            image: preview.journey.image,
            preferences: preview.preferences,
            itinerary: preview.itinerary,
          },
          content: text(
            `${preview.itinerary.title}: ${preview.itinerary.days.length} days from ${preview.preferences.startDate} for ${input.partySize}, estimated ${money(estimate.amount, estimate.currency)} (${estimate.withinBudget ? "within" : "over"} budget). ${estimate.rateNote}`,
          ),
        };
      }),
  );

  server.registerTool(
    "save_journey",
    {
      title: "Save journey to My trips",
      description:
        "Save a curated journey with the user's dates and preferences to their Sanaa Kenya account. Only call after the user asks to save. Does not book or charge.",
      inputSchema: journeyInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Saving to My trips…",
        "openai/toolInvocation/invoked": "Saved to My trips",
      },
    },
    (input, extra) =>
      run(() => {
        const user = account(extra, "trips:write");
        if (!rateLimit(`mcp:save:${user.id}`, 20, 3600))
          throw new AppError(
            "Too many saves this hour. Please try later.",
            429,
          );
        const plan = saveCatalogPlan(
          user.id,
          input.packageId,
          preferencesFor(input),
        );
        const result = {
          planId: plan.id,
          title: plan.itinerary.title,
          startDate: plan.preferences.startDate,
          endDate: plan.preferences.endDate,
          estimate: plan.itinerary.estimate,
          status: "saved",
        };
        return {
          structuredContent: result,
          content: text(
            `Saved "${result.title}" to My trips (plan ${result.planId}). Nothing is booked or charged. Ask the agency for a quote with request_quote.`,
          ),
        };
      }),
  );

  server.registerTool(
    "list_my_trips",
    {
      title: "List my trips",
      description:
        "List the user's saved trips with their quote status (saved, requested, quoted, payment_pending or paid).",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    (_args, extra) =>
      run(() => {
        const user = account(extra, "trips:read");
        const trips = userTrips(user.id);
        return {
          structuredContent: { trips },
          content: text(
            trips.length
              ? trips
                  .map(
                    (t) =>
                      `${t.title} (${t.startDate} to ${t.endDate}, plan ${t.planId}): ${t.status}${t.quote ? `, quoted ${money(t.quote.amount, t.quote.currency)}` : ""}`,
                  )
                  .join("\n")
              : "No saved trips yet.",
          ),
        };
      }),
  );

  server.registerTool(
    "request_quote",
    {
      title: "Request an agency quote",
      description:
        "Ask the agency to quote a saved trip. Repeating the request for the same trip returns the existing request. The agency confirms availability; nothing is charged.",
      inputSchema: {
        planId: z
          .string()
          .uuid()
          .describe("planId from save_journey or list_my_trips."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Requesting a quote…",
        "openai/toolInvocation/invoked": "Quote requested",
      },
    },
    ({ planId }, extra) =>
      run(() => {
        const user = account(extra, "trips:write");
        const booking = requestBooking(user.id, planId);
        return {
          structuredContent: {
            bookingId: booking.id,
            planId,
            status: booking.status,
          },
          content: text(
            `Quote ${booking.status === "requested" ? "requested" : `status: ${booking.status}`}. The agency checks availability and sends a quote to My trips; nothing has been booked or charged.`,
          ),
        };
      }),
  );

  return server;
}

function jsonError(
  status: number,
  message: string,
  headers: Record<string, string> = {},
) {
  return withCors(
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...headers,
      },
    }),
  );
}
/** Stateless Streamable HTTP endpoint; every request must carry a valid OAuth access token. */
export async function handleMcpRequest(request: Request): Promise<Response> {
  if (request.method === "OPTIONS")
    return withCors(new Response(null, { status: 204 }));
  const verified = verifyAccessToken(request.headers.get("authorization"));
  if (verified.status !== "ok")
    return jsonError(
      401,
      "Connect your Sanaa Kenya account to use this server.",
      {
        "WWW-Authenticate":
          verified.status === "invalid"
            ? bearerChallenge(
                "invalid_token",
                "The access token is invalid or expired.",
              )
            : bearerChallenge(),
      },
    );
  if (request.method !== "POST")
    return jsonError(
      405,
      "Use POST; this server does not offer standalone streams.",
      {
        Allow: "POST, OPTIONS",
      },
    );
  if (Number(request.headers.get("content-length") ?? 0) > 262144)
    return jsonError(413, "Request is too large.");
  const { grant } = verified;
  if (!rateLimit(`mcp:${grant.user.id}`, 120, 60))
    return jsonError(429, "Too many requests. Please wait a minute.");
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request, {
      authInfo: {
        token: grant.token,
        clientId: grant.clientId,
        scopes: grant.scopes,
        expiresAt: grant.expiresAt,
        extra: { grant },
      },
    });
    response.headers.set("Cache-Control", "no-store");
    return withCors(response);
  } finally {
    await server.close();
  }
}
