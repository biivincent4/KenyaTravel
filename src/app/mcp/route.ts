import { handleMcpRequest } from "@/lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handle = (request: Request) => handleMcpRequest(request);
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const OPTIONS = handle;
