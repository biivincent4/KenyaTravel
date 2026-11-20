import { authorizationServerMetadata } from "@/lib/oauth";
import { oauthJson, preflight } from "@/lib/oauth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = () => oauthJson(authorizationServerMetadata());
export const OPTIONS = preflight;
