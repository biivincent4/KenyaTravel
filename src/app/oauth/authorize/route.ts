import type { NextRequest } from "next/server";
import {
  createSession,
  currentUser,
  sessionHash,
  verifyCredentials,
} from "@/lib/auth";
import { rateLimit } from "@/lib/db";
import {
  authorizationRedirect,
  createPendingRequest,
  errorRedirect,
  issueAuthorizationCode,
  issuer,
  OAuthError,
  OAuthRedirectError,
  takePendingRequest,
  validateAuthorizationRequest,
} from "@/lib/oauth";
import { limitedText } from "@/lib/oauth-http";
import { consentPage, errorPage, signInPage } from "@/lib/oauth-pages";
import { credentialSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const pageHeaders = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  // Browsers send "Origin: null" on form posts from no-referrer pages, which the origin check would reject.
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};
const html = (body: string, status = 200) =>
  new Response(body, { status, headers: pageHeaders });
const redirect = (location: string) =>
  new Response(null, {
    status: 303,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });

async function show(params: URLSearchParams, loginError?: string) {
  let request;
  try {
    request = await validateAuthorizationRequest(params);
  } catch (error) {
    if (error instanceof OAuthRedirectError)
      return redirect(errorRedirect(error));
    if (error instanceof OAuthError) return html(errorPage(error.message), 400);
    throw error;
  }
  const user = await currentUser();
  const session = await sessionHash();
  if (!user || !session)
    return html(
      signInPage({
        query: params.toString(),
        clientName: request.clientName,
        error: loginError,
      }),
      loginError ? 401 : 200,
    );
  const requestId = createPendingRequest(user.id, session, request);
  return html(consentPage({ requestId, request, user }));
}

async function signIn(form: URLSearchParams) {
  const query = form.get("query") ?? "";
  if (query.length > 8000)
    throw new OAuthError("invalid_request", "The request is too long.");
  const params = new URLSearchParams(query);
  const credentials = credentialSchema.safeParse({
    email: form.get("email") ?? "",
    password: form.get("password") ?? "",
  });
  if (!credentials.success)
    return show(
      params,
      "Enter your email and password (at least 12 characters).",
    );
  const { email, password } = credentials.data;
  if (
    !rateLimit(`auth:${email}`, 10, 900) ||
    !rateLimit("auth:global", 200, 900)
  )
    return show(
      params,
      "Too many sign-in attempts. Please retry in 15 minutes.",
    );
  const userId = verifyCredentials(email, password);
  if (!userId) return show(params, "Email or password is incorrect.");
  await createSession(userId);
  const target = new URL("/oauth/authorize", issuer());
  target.search = params.toString();
  return redirect(target.toString());
}

async function decide(form: URLSearchParams) {
  const user = await currentUser();
  const session = await sessionHash();
  if (!user || !session)
    return html(
      errorPage("Your session expired. Return to the app and connect again."),
      401,
    );
  const request = takePendingRequest(
    form.get("request_id") ?? "",
    user.id,
    session,
  );
  if (form.get("decision") !== "allow")
    return redirect(
      authorizationRedirect(request.redirectUri, {
        error: "access_denied",
        error_description: "The user declined access.",
        state: request.state,
      }),
    );
  const code = issueAuthorizationCode(user.id, request);
  return redirect(
    authorizationRedirect(request.redirectUri, { code, state: request.state }),
  );
}

function failure(error: unknown) {
  if (error instanceof OAuthError)
    return html(errorPage(error.message), error.status === 413 ? 413 : 400);
  console.error("OAuth authorization failed", error);
  return html(
    errorPage("Something went wrong on the server. Please try again."),
    500,
  );
}

export async function GET(request: NextRequest) {
  try {
    return await show(request.nextUrl.searchParams);
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    // Same-origin check stops other sites submitting consent on the user's behalf.
    if (request.headers.get("origin") !== issuer())
      return html(errorPage("This form was submitted from another site."), 403);
    const form = new URLSearchParams(await limitedText(request));
    const action = form.get("action");
    if (action === "login") return await signIn(form);
    if (action === "consent") return await decide(form);
    return html(errorPage("Unknown action."), 400);
  } catch (error) {
    return failure(error);
  }
}
