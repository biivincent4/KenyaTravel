import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { z } from "zod";
import {
  createSession,
  createUser,
  currentUser,
  hashPassword,
  logout,
  requireUser,
  verifyPassword,
  googleCookieName,
  googleCookiePath,
  secureCookies,
  sessionHash,
} from "@/lib/auth";
import {
  db,
  packages,
  parsePlan,
  rateLimit,
  type User,
  type PlanRow,
} from "@/lib/db";
import {
  AppError,
  credentialSchema,
  preferenceSchema,
  quoteSchema,
} from "@/lib/validation";
import { askAI, aiReady } from "@/lib/ai";
import {
  createCheckout,
  paymentReady,
  verifyWebhook,
  applyPaymentEvent,
} from "@/lib/payments";
import { issueQuote, requestBooking, saveCatalogPlan } from "@/lib/travel";
import { destinations } from "@/lib/catalog";
import {
  applicationOrigin,
  consumeGoogleAttempt,
  createGoogleAttempt,
  exchangeGoogleCode,
  GoogleAuthError,
  googleReady,
  hasGoogleAccount,
  resolveGoogleAccount,
  returnSections,
  type ReturnSection,
} from "@/lib/google";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const dummyHash = hashPassword("not-a-real-account-password");
const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
async function body(request: NextRequest) {
  if (Number(request.headers.get("content-length") ?? 0) > 65536)
    throw new AppError("Request is too large.", 413);
  const text = await request.text();
  if (Buffer.byteLength(text) > 65536)
    throw new AppError("Request is too large.", 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("Send a valid JSON request.");
  }
}
async function googleCallback(request: NextRequest) {
  const target = new URL("/", applicationOrigin());
  const jar = await cookies();
  let consumed = false;
  let section: ReturnSection = "trips";
  try {
    const params = request.nextUrl.searchParams;
    if (params.getAll("state").length !== 1)
      throw new GoogleAuthError("expired");
    const attempt = consumeGoogleAttempt(
      params.get("state"),
      jar.get(googleCookieName)?.value,
      await sessionHash(),
    );
    consumed = true;
    section = attempt.return_section;
    const user = await currentUser();
    if (
      attempt.link_user_id ? user?.id !== attempt.link_user_id : user !== null
    )
      throw new GoogleAuthError("session", 401);
    if (params.has("error")) throw new GoogleAuthError("denied");
    const code = params.get("code");
    if (!code || code.length > 4096 || params.getAll("code").length !== 1)
      throw new GoogleAuthError("failed");
    const identity = await exchangeGoogleCode(code, attempt);
    // Link callbacks require the same still-valid authenticated session after the provider round trip.
    if (
      attempt.link_user_id &&
      (await currentUser())?.id !== attempt.link_user_id
    )
      throw new GoogleAuthError("session", 401);
    const id = resolveGoogleAccount(identity, attempt.link_user_id);
    await createSession(id);
    target.searchParams.set(
      "google",
      attempt.link_user_id ? "linked" : "signed-in",
    );
  } catch (error) {
    const code = error instanceof GoogleAuthError ? error.code : "failed";
    console.error("Google authentication rejected", code);
    target.searchParams.set("googleError", code);
  } finally {
    if (consumed)
      jar.set(googleCookieName, "", {
        httpOnly: true,
        secure: secureCookies(),
        sameSite: "lax",
        path: googleCookiePath,
        maxAge: 0,
      });
  }
  target.hash = section;
  const response = NextResponse.redirect(target, 303);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
async function handle(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const path = (await context.params).path.join("/");
    const method = request.method;
    if (path === "auth/google/callback" && method === "GET")
      return await googleCallback(request);
    if (path === "webhooks/stripe" && method === "POST") {
      if (Number(request.headers.get("content-length") ?? 0) > 1048576)
        throw new AppError("Webhook is too large.", 413);
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 1048576)
        throw new AppError("Webhook is too large.", 413);
      const event = verifyWebhook(
        raw,
        request.headers.get("stripe-signature") ?? "",
      );
      return json(applyPaymentEvent(event));
    }
    if (method !== "GET") {
      const expected = new URL(process.env.APP_URL || "http://localhost:3000")
        .origin;
      if (request.headers.get("origin") !== expected)
        throw new AppError("Request origin is not allowed.", 403);
    }
    if (path === "session" && method === "GET") {
      const user = await currentUser();
      return json({
        user,
        aiReady: aiReady(),
        paymentReady: paymentReady(),
        googleReady: googleReady(),
        googleLinked: user ? hasGoogleAccount(user.id) : false,
      });
    }
    if (path === "catalog" && method === "GET")
      return json({ destinations, packages: packages() });
    if (path === "auth/logout" && method === "POST") {
      await logout();
      return json({ ok: true });
    }
    if (path === "auth/google/start" && method === "POST") {
      const input = z
        .object({
          intent: z.enum(["signin", "link"]),
          returnSection: z.enum(returnSections).default("trips"),
          password: z.string().min(12).max(128).optional(),
        })
        .strict()
        .parse(await body(request));
      if (!googleReady()) throw new GoogleAuthError("unavailable", 503);
      const user = await currentUser();
      if (input.intent === "signin" && user)
        throw new GoogleAuthError("session", 409);
      if (!rateLimit("google:start:global", 100, 3600))
        throw new AppError(
          "Too many Google sign-in attempts. Please try again later.",
          429,
        );
      if (input.intent === "link") {
        if (!user)
          throw new AppError(
            "Sign in with your existing account before connecting Google.",
            401,
          );
        if (!rateLimit(`google:link:${user.id}`, 10, 900))
          throw new AppError(
            "Too many account-link attempts. Please retry in 15 minutes.",
            429,
          );
        const row = db()
          .prepare("SELECT password_hash FROM users WHERE id=?")
          .get(user.id) as { password_hash: string };
        if (
          !input.password ||
          !verifyPassword(input.password, row.password_hash)
        )
          throw new AppError(
            "Your current password is required to connect Google.",
            401,
          );
        if (hasGoogleAccount(user.id))
          throw new AppError(
            "Google is already connected to this account.",
            409,
          );
      }
      const jar = await cookies();
      const result = createGoogleAttempt(
        input.returnSection,
        input.intent === "link" ? user!.id : null,
        await sessionHash(),
        jar.get(googleCookieName)?.value,
      );
      jar.set(googleCookieName, result.state, {
        httpOnly: true,
        secure: secureCookies(),
        sameSite: "lax",
        path: googleCookiePath,
        maxAge: 600,
      });
      return json({ url: result.url });
    }
    if (["auth/register", "auth/login"].includes(path) && method === "POST") {
      const input = await body(request);
      const credentials = credentialSchema.parse(input);
      if (
        !rateLimit(`auth:${credentials.email}`, 10, 900) ||
        !rateLimit("auth:global", 200, 900)
      )
        throw new AppError(
          "Too many authentication attempts. Please retry in 15 minutes.",
          429,
        );
      if (path === "auth/register") {
        const { name } = z
          .object({ name: z.string().trim().min(2).max(80) })
          .parse(input);
        if (!rateLimit("register:global", 30, 3600))
          throw new AppError(
            "Registration limit reached. Please try later.",
            429,
          );
        if (
          db()
            .prepare("SELECT id FROM users WHERE email=?")
            .get(credentials.email)
        )
          throw new AppError(
            "Unable to create this account. Try signing in or contact the agency.",
            409,
          );
        const id = createUser(credentials.email, name, credentials.password);
        await createSession(id);
      } else {
        const row = db()
          .prepare("SELECT id,password_hash FROM users WHERE email=?")
          .get(credentials.email) as
          (User & { password_hash: string }) | undefined;
        const valid = verifyPassword(
          credentials.password,
          row?.password_hash || dummyHash,
        );
        if (!row || !valid)
          throw new AppError("Email or password is incorrect.", 401);
        await createSession(row.id);
      }
      return json({ user: await currentUser() });
    }
    const user = await requireUser(path.startsWith("admin/"));
    if (method !== "GET" && !rateLimit(`action:${user.id}`, 60, 60))
      throw new AppError("Too many requests. Please wait a minute.", 429);
    if (path === "trips" && method === "GET")
      return json({
        plans: (
          db()
            .prepare(
              "SELECT * FROM plans WHERE user_id=? ORDER BY created_at DESC",
            )
            .all(user.id) as PlanRow[]
        ).map(parsePlan),
        bookings: db()
          .prepare(
            "SELECT * FROM bookings WHERE user_id=? ORDER BY created_at DESC",
          )
          .all(user.id),
        enquiries: db()
          .prepare(
            "SELECT * FROM enquiries WHERE user_id=? ORDER BY created_at DESC",
          )
          .all(user.id),
      });
    if (path === "plans/catalog" && method === "POST") {
      const input = z
        .object({
          packageId: z.string().max(60),
          preferences: preferenceSchema,
        })
        .parse(await body(request));
      return json(
        { plan: saveCatalogPlan(user.id, input.packageId, input.preferences) },
        201,
      );
    }
    if (path === "bookings" && method === "POST") {
      const { planId } = z
        .object({ planId: z.string().uuid() })
        .parse(await body(request));
      return json({ booking: requestBooking(user.id, planId) }, 201);
    }
    if (path === "checkout" && method === "POST") {
      const { bookingId } = z
        .object({ bookingId: z.string().uuid() })
        .parse(await body(request));
      return json({ url: await createCheckout(user.id, bookingId) });
    }
    if (path === "enquiries" && method === "POST") {
      const { message } = z
        .object({ message: z.string().trim().min(10).max(3000) })
        .parse(await body(request));
      db()
        .prepare("INSERT INTO enquiries(id,user_id,message) VALUES (?,?,?)")
        .run(randomUUID(), user.id, message);
      return json({ ok: true }, 201);
    }
    if (path === "ai" && method === "POST") {
      const input = z
        .object({
          mode: z.enum(["plan", "enquiry"]),
          message: z.string().trim().min(3).max(2000),
          preferences: preferenceSchema.optional(),
          previousPlanId: z.string().uuid().optional(),
        })
        .parse(await body(request));
      if (input.mode === "plan" && !input.preferences)
        throw new AppError(
          "Travel dates, party size, budget and interests are required.",
        );
      if (!rateLimit(`ai:${user.id}`, 12, 3600))
        throw new AppError(
          "Your AI request limit is reached. Try again in an hour or contact the agency.",
          429,
        );
      return json(
        await askAI(
          user.id,
          input.mode,
          input.message,
          input.preferences,
          input.previousPlanId,
        ),
      );
    }
    if (path === "admin/overview" && method === "GET")
      return json({
        bookings: db()
          .prepare(
            "SELECT b.*,u.name,u.email,json_extract(p.itinerary,'$.title') title FROM bookings b JOIN users u ON u.id=b.user_id JOIN plans p ON p.id=b.plan_id ORDER BY b.created_at DESC",
          )
          .all(),
        plans: (
          db()
            .prepare(
              "SELECT p.* FROM plans p JOIN bookings b ON b.plan_id=p.id ORDER BY p.created_at DESC",
            )
            .all() as PlanRow[]
        ).map(parsePlan),
        enquiries: db()
          .prepare(
            "SELECT e.*,u.name,u.email FROM enquiries e JOIN users u ON u.id=e.user_id ORDER BY e.created_at DESC",
          )
          .all(),
        packages: packages(true),
      });
    if (path === "admin/quote" && method === "POST") {
      const input = quoteSchema.parse(await body(request));
      return json({
        booking: issueQuote(
          input.bookingId,
          input.amount,
          input.currency,
          input.notes,
          input.expiresAt,
        ),
      });
    }
    if (path === "admin/reply" && method === "POST") {
      const input = z
        .object({
          id: z.string().uuid(),
          reply: z.string().trim().min(3).max(3000),
        })
        .parse(await body(request));
      const result = db()
        .prepare("UPDATE enquiries SET reply=? WHERE id=?")
        .run(input.reply, input.id);
      if (!result.changes) throw new AppError("Enquiry not found.", 404);
      return json({ ok: true });
    }
    if (path === "admin/package" && method === "POST") {
      const input = z
        .object({
          id: z.string().max(60),
          description: z.string().trim().min(20).max(2000),
          active: z.boolean(),
        })
        .parse(await body(request));
      const item = packages(true).find((p) => p.id === input.id);
      if (!item) throw new AppError("Package not found.", 404);
      db()
        .prepare("UPDATE packages SET content=? WHERE id=?")
        .run(
          JSON.stringify({
            ...item,
            description: input.description,
            active: input.active,
          }),
          input.id,
        );
      return json({ ok: true });
    }
    throw new AppError("Endpoint not found.", 404);
  } catch (error) {
    if (error instanceof z.ZodError)
      return json({ error: error.issues.map((i) => i.message).join(" ") }, 400);
    if (error instanceof AppError) {
      if (error.status >= 500 || request.nextUrl.pathname.includes("webhooks"))
        console.error(
          "Request failed",
          request.nextUrl.pathname,
          error.message,
        );
      return json({ error: error.message }, error.status);
    }
    console.error("Unhandled API failure", error);
    return json(
      {
        error:
          "Something went wrong on the server. Your payment or booking has not been assumed successful. Please retry or contact the agency.",
      },
      500,
    );
  }
}
export const GET = handle;
export const POST = handle;
