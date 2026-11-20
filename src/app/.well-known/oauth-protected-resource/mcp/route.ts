import { protectedResourceMetadata } from "@/lib/oauth";
import { oauthJson, preflight } from "@/lib/oauth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// RFC 9728 path-suffixed location for the /mcp resource.
export const GET = () => oauthJson(protectedResourceMetadata());
export const OPTIONS = preflight;
