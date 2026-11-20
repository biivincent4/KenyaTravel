import { rateLimit } from "@/lib/db";
import { OAuthError, registerClient } from "@/lib/oauth";
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
    if (!rateLimit("oauth:register:global", 100, 3600))
      throw new OAuthError(
        "temporarily_unavailable",
        "Too many client registrations. Try again later.",
        429,
      );
    let input: unknown;
    try {
      input = JSON.parse(await limitedText(request));
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      throw new OAuthError("invalid_client_metadata", "Send a JSON object.");
    }
    return oauthJson(registerClient(input), 201);
  } catch (error) {
    return oauthFailure(error);
  }
}
export const OPTIONS = preflight;
