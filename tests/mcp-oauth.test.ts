import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createUser } from "../src/lib/auth";
import { db } from "../src/lib/db";
import {
  authorizationServerMetadata,
  errorRedirect,
  exchangeToken,
  issueAuthorizationCode,
  OAuthError,
  OAuthRedirectError,
  protectedResourceMetadata,
  registerClient,
  validateAuthorizationRequest,
  verifyAccessToken,
} from "../src/lib/oauth";
import { handleMcpRequest, widgetMimeType, widgetUri } from "../src/lib/mcp";
import { dateForDay } from "../src/lib/validation";
import {
  buildWidgetModule,
  generatedWidgetPath,
} from "../scripts/widget-bundle";

const directory = mkdtempSync(join(tmpdir(), "sanaa-mcp-"));
process.env.DATABASE_PATH = join(directory, "mcp.sqlite");
process.env.APP_URL = "https://travel.example.test";
after(() => {
  db().close();
  rmSync(directory, { recursive: true, force: true });
});

const origin = "https://travel.example.test";
const resource = `${origin}/mcp`;
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const password = randomBytes(16).toString("hex");
const travellerId = createUser("traveller@example.test", "Amina", password);
const otherId = createUser("other@example.test", "Brian", password);
const startDate = dateForDay(new Date().toISOString().slice(0, 10), 60);

function authParams(clientId: string, overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    resource,
    ...overrides,
  });
}
async function connect(userId = travellerId, scope?: string) {
  const client = registerClient({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
  });
  const request = await validateAuthorizationRequest(
    authParams(client.client_id, scope ? { scope } : {}),
  );
  const code = issueAuthorizationCode(userId, request);
  const tokens = await exchangeToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      code_verifier: verifier,
      resource,
    }),
  );
  return { clientId: client.client_id, tokens };
}
async function rpc(
  accessToken: string | null,
  method: string,
  params: Record<string, unknown> = {},
) {
  const response = await handleMcpRequest(
    new Request(resource, {
      method: "POST",
      headers: {
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const body = response.status === 200 ? await response.json() : null;
  return { response, result: body?.result, error: body?.error };
}
const callTool = (token: string, name: string, args: object = {}) =>
  rpc(token, "tools/call", { name, arguments: args });
const journey = {
  packageId: "wild-heart",
  startDate,
  partySize: 2,
  budget: 5000,
  currency: "USD",
  interests: ["Wildlife"],
};

test("discovery metadata links the MCP resource to this authorization server", () => {
  const prm = protectedResourceMetadata();
  const as = authorizationServerMetadata();
  assert.equal(prm.resource, resource);
  assert.deepEqual(prm.authorization_servers, [as.issuer]);
  assert.equal(as.issuer, origin);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.equal(as.client_id_metadata_document_supported, true);
});

test("dynamic registration accepts only HTTPS or loopback redirect URIs", () => {
  for (const uri of [
    "http://evil.example/callback",
    "https://app.example/cb#fragment",
    "javascript:alert(1)",
  ])
    assert.throws(
      () => registerClient({ redirect_uris: [uri] }),
      (error: unknown) =>
        error instanceof OAuthError && error.code === "invalid_redirect_uri",
    );
  const client = registerClient({
    redirect_uris: ["http://localhost:6274/oauth/callback"],
  });
  assert.match(client.client_id, /^mcp_/);
  assert.equal(client.token_endpoint_auth_method, "none");
});

test("authorization errors never redirect to unregistered URIs", async () => {
  const { client_id } = registerClient({ redirect_uris: [redirectUri] });
  await assert.rejects(
    validateAuthorizationRequest(
      authParams(client_id, { redirect_uri: "https://attacker.example/cb" }),
    ),
    (error: unknown) =>
      error instanceof OAuthError && !(error instanceof OAuthRedirectError),
  );
  for (const [overrides, code] of [
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ resource: "https://other.example/mcp" }, "invalid_target"],
    [{ scope: "trips:read admin" }, "invalid_scope"],
    [{ response_type: "token" }, "unsupported_response_type"],
  ] as const) {
    const error = await validateAuthorizationRequest(
      authParams(client_id, overrides),
    ).catch((e) => e);
    assert.ok(error instanceof OAuthRedirectError, code);
    assert.equal(error.code, code);
    const url = new URL(errorRedirect(error));
    assert.equal(url.searchParams.get("state"), "state-123");
    assert.equal(url.searchParams.get("iss"), origin);
  }
});

test("client metadata documents load only from allowlisted HTTPS hosts", async () => {
  const realFetch = globalThis.fetch;
  const documentUrl = "https://chatgpt.com/oauth/client.json";
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return new Response(
      JSON.stringify({
        client_id: documentUrl,
        client_name: "ChatGPT",
        redirect_uris: [redirectUri],
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
        token_endpoint_auth_method: "private_key_jwt",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const request = await validateAuthorizationRequest(authParams(documentUrl));
    assert.equal(request.clientName, "ChatGPT");
    await validateAuthorizationRequest(authParams(documentUrl));
    assert.equal(fetched, 1, "metadata documents are cached");
    await assert.rejects(
      validateAuthorizationRequest(
        authParams("https://attacker.example/client.json"),
      ),
      (error: unknown) =>
        error instanceof OAuthError && error.code === "invalid_client",
    );
    assert.equal(fetched, 1, "disallowed hosts are never fetched");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("authorization codes need the PKCE verifier and work only once", async () => {
  const { client_id } = registerClient({ redirect_uris: [redirectUri] });
  const request = await validateAuthorizationRequest(authParams(client_id));
  const exchange = (code: string, codeVerifier = verifier) =>
    exchangeToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id,
        code_verifier: codeVerifier,
      }),
    );
  const stolen = issueAuthorizationCode(travellerId, request);
  await assert.rejects(
    exchange(stolen, randomBytes(32).toString("base64url")),
    {
      code: "invalid_grant",
    },
  );
  await assert.rejects(exchange(stolen), { code: "invalid_grant" });
  const code = issueAuthorizationCode(travellerId, request);
  const tokens = await exchange(code);
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.scope, "trips:read trips:write");
  await assert.rejects(exchange(code), { code: "invalid_grant" });
});

test("refresh tokens rotate and a replayed refresh token revokes the grant", async () => {
  const { clientId, tokens } = await connect();
  const refresh = (refreshToken: string) =>
    exchangeToken(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    );
  const rotated = await refresh(tokens.refresh_token);
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  assert.equal(
    verifyAccessToken(`Bearer ${rotated.access_token}`).status,
    "ok",
  );
  await assert.rejects(refresh(tokens.refresh_token), {
    code: "invalid_grant",
  });
  assert.equal(
    verifyAccessToken(`Bearer ${rotated.access_token}`).status,
    "invalid",
  );
  await assert.rejects(refresh(rotated.refresh_token), {
    code: "invalid_grant",
  });
});

test("the MCP endpoint challenges requests without a valid token", async () => {
  const missing = await rpc(null, "tools/list");
  assert.equal(missing.response.status, 401);
  const challengeHeader = missing.response.headers.get("www-authenticate")!;
  assert.match(
    challengeHeader,
    /resource_metadata="https:\/\/travel\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
  const forged = await rpc(randomBytes(32).toString("base64url"), "tools/list");
  assert.equal(forged.response.status, 401);
  assert.match(
    forged.response.headers.get("www-authenticate")!,
    /error="invalid_token"/,
  );
});

test("tools and the MCP Apps itinerary card are advertised", async () => {
  const { tokens } = await connect();
  const { result } = await rpc(tokens.access_token, "tools/list");
  const tools = Object.fromEntries(
    result.tools.map((tool: { name: string }) => [tool.name, tool]),
  );
  assert.deepEqual(Object.keys(tools).sort(), [
    "get_profile",
    "list_my_trips",
    "plan_journey",
    "request_quote",
    "save_journey",
    "search_journeys",
  ]);
  assert.equal(tools.plan_journey._meta.ui.resourceUri, widgetUri);
  assert.equal(tools.get_profile._meta["openai/profile"], true);
  assert.equal(tools.save_journey.annotations.readOnlyHint, false);
  const read = await rpc(tokens.access_token, "resources/read", {
    uri: widgetUri,
  });
  const [content] = read.result.contents;
  assert.equal(content.mimeType, widgetMimeType);
  assert.match(content.text, /<div id="root"><\/div>/);
});

test("a connected traveller can plan, save and request a quote for their own trip", async () => {
  const { tokens } = await connect();
  const token = tokens.access_token;
  const profile = await callTool(token, "get_profile");
  assert.equal(profile.result.structuredContent.id, travellerId);
  const search = await callTool(token, "search_journeys", {
    interest: "Beach",
  });
  assert.deepEqual(
    search.result.structuredContent.journeys.map((j: { id: string }) => j.id),
    ["coastal-slow"],
  );
  const planned = await callTool(token, "plan_journey", journey);
  const itinerary = planned.result.structuredContent.itinerary;
  assert.equal(itinerary.days.length, 6);
  assert.equal(itinerary.estimate.amount, (130 + 150 * 2 + 290 * 3) * 2);
  assert.equal(itinerary.estimate.withinBudget, true);
  const saved = await callTool(token, "save_journey", journey);
  const { planId } = saved.result.structuredContent;
  const trips = await callTool(token, "list_my_trips");
  assert.deepEqual(
    trips.result.structuredContent.trips.map(
      (t: { planId: string; status: string }) => [t.planId, t.status],
    ),
    [[planId, "saved"]],
  );
  const quote = await callTool(token, "request_quote", { planId });
  assert.equal(quote.result.structuredContent.status, "requested");
  const again = await callTool(token, "request_quote", { planId });
  assert.equal(
    again.result.structuredContent.bookingId,
    quote.result.structuredContent.bookingId,
  );
  const intruder = await connect(otherId);
  const denied = await callTool(intruder.tokens.access_token, "request_quote", {
    planId,
  });
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /not found/i);
});

test("write tools need the trips:write scope and invalid trips are rejected", async () => {
  const { tokens } = await connect(travellerId, "trips:read");
  const save = await callTool(tokens.access_token, "save_journey", journey);
  assert.equal(save.result.isError, true);
  assert.match(
    save.result._meta["mcp/www_authenticate"][0],
    /error="insufficient_scope".*|scope="trips:write"/,
  );
  const past = await callTool(tokens.access_token, "plan_journey", {
    ...journey,
    startDate: "2020-01-01",
  });
  assert.equal(past.result.isError, true);
  assert.match(past.result.content[0].text, /today or later/);
});

test("the committed widget bundle matches its source", async () => {
  const normalize = (value: string) => value.replace(/\r\n/g, "\n");
  assert.equal(
    normalize(readFileSync(generatedWidgetPath, "utf8")),
    normalize(await buildWidgetModule()),
    "Run npm run build:widget",
  );
});
