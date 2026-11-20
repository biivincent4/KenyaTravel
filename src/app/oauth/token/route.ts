import { rateLimit } from "@/lib/db";
import { exchangeToken, OAuthError } from "@/lib/oauth";
import {
  limitedText,
  oauthFailure,
  oauthJson,
  preflight,
} from "@/lib/oauth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/x-www-form-urlencoded")
    )
      throw new OAuthError(
        "invalid_request",
        "Send application/x-www-form-urlencoded parameters.",
      );
    const form = new URLSearchParams(await limitedText(request));
    if (!rateLimit(`oauth:token:${form.get("client_id") ?? ""}`, 60, 60))
      throw new OAuthError(
        "temporarily_unavailable",
        "Too many token requests. Wait a minute.",
        429,
      );
    return oauthJson(await exchangeToken(form));
  } catch (error) {
    return oauthFailure(error);
  }
}
export const OPTIONS = preflight;
