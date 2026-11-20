import { OAuthError } from "./oauth";
import { withCors } from "./mcp";

export function oauthJson(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return withCors(
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        ...headers,
      },
    }),
  );
}
export function oauthFailure(error: unknown) {
  if (error instanceof OAuthError)
    return oauthJson(
      { error: error.code, error_description: error.message },
      error.status,
    );
  console.error("OAuth endpoint failed", error);
  return oauthJson(
    { error: "server_error", error_description: "Unexpected server error." },
    500,
  );
}
export async function limitedText(request: Request, max = 16384) {
  if (Number(request.headers.get("content-length") ?? 0) > max)
    throw new OAuthError("invalid_request", "Request is too large.", 413);
  const text = await request.text();
  if (Buffer.byteLength(text) > max)
    throw new OAuthError("invalid_request", "Request is too large.", 413);
  return text;
}
export const preflight = () => withCors(new Response(null, { status: 204 }));
