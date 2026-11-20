import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { db, transaction, type User } from "./db";
import { applicationOrigin } from "./google";

export const oauthScopes = ["trips:read", "trips:write"] as const;
export type OAuthScope = (typeof oauthScopes)[number];
export const scopeDescriptions: Record<OAuthScope, string> = {
  "trips:read": "See your profile, curated journeys and your saved trips",
  "trips:write": "Save itineraries to My trips and request agency quotes",
};
const accessTokenSeconds = 3600;
const refreshTokenMs = 30 * 86400000;
const codeMs = 5 * 60000;
const requestMs = 10 * 60000;
const cimdCacheMs = 60 * 60000;

export class OAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
/** An error that can safely be returned to a validated client redirect URI. */
export class OAuthRedirectError extends OAuthError {
  constructor(
    code: string,
    message: string,
    public redirectUri: string,
    public state: string | undefined,
  ) {
    super(code, message);
  }
}

export const issuer = () => applicationOrigin();
export const mcpResource = () => `${issuer()}/mcp`;
export const resourceMetadataUrl = () =>
  `${issuer()}/.well-known/oauth-protected-resource/mcp`;

export function protectedResourceMetadata() {
  return {
    resource: mcpResource(),
    authorization_servers: [issuer()],
    scopes_supported: [...oauthScopes],
    bearer_methods_supported: ["header"],
    resource_name: "Sanaa Kenya trips",
    resource_documentation: `${issuer()}/#journeys`,
  };
}
export function authorizationServerMetadata() {
  const base = issuer();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...oauthScopes],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");

export function bearerChallenge(
  error?: "invalid_token" | "insufficient_scope",
  description?: string,
  scope: string = oauthScopes.join(" "),
) {
  let value = `Bearer resource_metadata="${resourceMetadataUrl()}", scope="${scope}"`;
  if (error)
    value += `, error="${error}", error_description="${(description ?? "").replace(/["\\]/g, "")}"`;
  return value;
}

export function validRedirectUri(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return (
    value.length <= 2000 &&
    !url.hash &&
    !url.username &&
    !url.password &&
    (url.protocol === "https:" || (url.protocol === "http:" && loopback))
  );
}

export type OAuthClient = {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  kind: "dcr" | "cimd";
};
type ClientRow = Omit<OAuthClient, "redirect_uris"> & {
  redirect_uris: string;
  expires_at: number | null;
};
const parseClient = (row: ClientRow): OAuthClient => ({
  client_id: row.client_id,
  client_name: row.client_name,
  redirect_uris: JSON.parse(row.redirect_uris),
  kind: row.kind,
});

const registrationSchema = z.looseObject({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().trim().min(1).max(100).optional(),
});
/** RFC 7591 dynamic client registration. Every client is public and must use PKCE. */
export function registerClient(input: unknown) {
  const parsed = registrationSchema.safeParse(input);
  if (!parsed.success)
    throw new OAuthError(
      "invalid_client_metadata",
      "Send redirect_uris (1 to 10) and an optional client_name.",
    );
  const { redirect_uris, client_name = "MCP client" } = parsed.data;
  if (!redirect_uris.every(validRedirectUri))
    throw new OAuthError(
      "invalid_redirect_uri",
      "Redirect URIs must use HTTPS (HTTP only on loopback) without a fragment.",
    );
  const clientId = `mcp_${randomUUID()}`;
  const issuedAt = Date.now();
  db()
    .prepare(
      "INSERT INTO oauth_clients(client_id,kind,client_name,redirect_uris,created_at) VALUES (?,'dcr',?,?,?)",
    )
    .run(clientId, client_name, JSON.stringify(redirect_uris), issuedAt);
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(issuedAt / 1000),
    client_name,
    redirect_uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: oauthScopes.join(" "),
  };
}

const cimdSchema = z.looseObject({
  client_id: z.string(),
  client_name: z.string().trim().min(1).max(100).optional(),
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  token_endpoint_auth_method: z.string().max(50).optional(),
  token_endpoint_auth_methods_supported: z
    .array(z.string().max(50))
    .max(10)
    .optional(),
});
function cimdHosts() {
  return (process.env.OAUTH_CIMD_HOSTS ?? "chatgpt.com,claude.ai")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}
/** Client ID Metadata Documents: the client_id is an HTTPS URL describing the client. */
async function metadataDocumentClient(clientId: string): Promise<OAuthClient> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new OAuthError("invalid_client", "Unknown OAuth client.", 401);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname === "/" ||
    url.href !== clientId ||
    !cimdHosts().includes(url.hostname.toLowerCase())
  )
    throw new OAuthError(
      "invalid_client",
      "This client metadata document host is not allowed.",
      401,
    );
  const cached = db()
    .prepare(
      "SELECT * FROM oauth_clients WHERE client_id=? AND kind='cimd' AND expires_at>?",
    )
    .get(clientId, Date.now()) as ClientRow | undefined;
  if (cached) return parseClient(cached);
  let document: unknown;
  try {
    const response = await fetch(clientId, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (
      !response.ok ||
      Number(response.headers.get("content-length") ?? 0) > 16384
    )
      throw new Error("unavailable");
    const text = await response.text();
    if (Buffer.byteLength(text) > 16384) throw new Error("too large");
    document = JSON.parse(text);
  } catch {
    throw new OAuthError(
      "invalid_client",
      "The client metadata document could not be loaded.",
      401,
    );
  }
  const parsed = cimdSchema.safeParse(document);
  if (!parsed.success || parsed.data.client_id !== clientId)
    throw new OAuthError(
      "invalid_client",
      "The client metadata document is invalid.",
      401,
    );
  const methods = parsed.data.token_endpoint_auth_methods_supported ?? [
    parsed.data.token_endpoint_auth_method ?? "none",
  ];
  if (
    !methods.includes("none") ||
    !parsed.data.redirect_uris.every(validRedirectUri)
  )
    throw new OAuthError(
      "invalid_client",
      "The client must support public PKCE token exchange and HTTPS redirects.",
      401,
    );
  const client: OAuthClient = {
    client_id: clientId,
    client_name: parsed.data.client_name ?? url.hostname,
    redirect_uris: parsed.data.redirect_uris,
    kind: "cimd",
  };
  db()
    .prepare(
      "INSERT INTO oauth_clients(client_id,kind,client_name,redirect_uris,created_at,expires_at) VALUES (?,'cimd',?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET client_name=excluded.client_name,redirect_uris=excluded.redirect_uris,expires_at=excluded.expires_at",
    )
    .run(
      clientId,
      client.client_name,
      JSON.stringify(client.redirect_uris),
      Date.now(),
      Date.now() + cimdCacheMs,
    );
  return client;
}
export async function resolveClient(clientId: string): Promise<OAuthClient> {
  if (!clientId || clientId.length > 2000)
    throw new OAuthError("invalid_client", "Unknown OAuth client.", 401);
  if (clientId.startsWith("https://")) return metadataDocumentClient(clientId);
  const row = db()
    .prepare("SELECT * FROM oauth_clients WHERE client_id=? AND kind='dcr'")
    .get(clientId) as ClientRow | undefined;
  if (!row)
    throw new OAuthError("invalid_client", "Unknown OAuth client.", 401);
  return parseClient(row);
}

function single(params: URLSearchParams, name: string) {
  const values = params.getAll(name);
  if (values.length > 1)
    throw new OAuthError("invalid_request", `Send ${name} only once.`);
  return values[0] || undefined;
}
function sameResource(value: string | undefined) {
  return !value || value.replace(/\/$/, "") === mcpResource();
}
export function parseScope(value: string | undefined): OAuthScope[] | null {
  if (!value?.trim()) return [...oauthScopes];
  const requested = [...new Set(value.trim().split(/\s+/))];
  return requested.every((s) => (oauthScopes as readonly string[]).includes(s))
    ? (requested as OAuthScope[])
    : null;
}

export type AuthorizationRequest = {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scopes: OAuthScope[];
  resource: string;
};
/**
 * Validates an authorization request. Client and redirect URI problems throw
 * OAuthError (show an error page, never redirect); everything else throws
 * OAuthRedirectError so the client receives a standard error response.
 */
export async function validateAuthorizationRequest(
  params: URLSearchParams,
): Promise<AuthorizationRequest> {
  const clientId = single(params, "client_id");
  const redirectUri = single(params, "redirect_uri");
  if (!clientId || !redirectUri)
    throw new OAuthError(
      "invalid_request",
      "client_id and redirect_uri are required.",
    );
  const client = await resolveClient(clientId);
  if (!client.redirect_uris.includes(redirectUri))
    throw new OAuthError(
      "invalid_request",
      "The redirect URI is not registered for this client.",
    );
  const state = params.getAll("state")[0];
  const fail = (code: string, message: string): never => {
    throw new OAuthRedirectError(code, message, redirectUri, state);
  };
  try {
    if (state !== undefined && state.length > 1000)
      fail("invalid_request", "state is too long.");
    if (single(params, "response_type") !== "code")
      fail(
        "unsupported_response_type",
        "Only response_type=code is supported.",
      );
    const challenge = single(params, "code_challenge");
    if (
      single(params, "code_challenge_method") !== "S256" ||
      !challenge ||
      !/^[A-Za-z0-9_-]{43}$/.test(challenge)
    )
      fail(
        "invalid_request",
        "PKCE with code_challenge_method=S256 is required.",
      );
    if (!sameResource(single(params, "resource")))
      fail(
        "invalid_target",
        "This server only issues tokens for its MCP endpoint.",
      );
    const scopes = parseScope(single(params, "scope"));
    if (!scopes) fail("invalid_scope", "An unsupported scope was requested.");
    return {
      clientId,
      clientName: client.client_name,
      redirectUri,
      state,
      codeChallenge: challenge!,
      scopes: scopes!,
      resource: mcpResource(),
    };
  } catch (error) {
    if (error instanceof OAuthRedirectError) throw error;
    if (error instanceof OAuthError)
      throw new OAuthRedirectError(
        error.code,
        error.message,
        redirectUri,
        state,
      );
    throw error;
  }
}

export function authorizationRedirect(
  redirectUri: string,
  values: Record<string, string | undefined>,
) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) url.searchParams.set(key, value);
  url.searchParams.set("iss", issuer());
  return url.toString();
}
export function errorRedirect(error: OAuthRedirectError) {
  return authorizationRedirect(error.redirectUri, {
    error: error.code,
    error_description: error.message,
    state: error.state,
  });
}

/** Stores a validated request for the consent screen, bound to the browser session. */
export function createPendingRequest(
  userId: string,
  sessionHash: string,
  request: AuthorizationRequest,
) {
  const id = token();
  db()
    .prepare("DELETE FROM oauth_requests WHERE expires_at<=?")
    .run(Date.now());
  db()
    .prepare(
      "INSERT INTO oauth_requests(id,user_id,session_hash,request,expires_at) VALUES (?,?,?,?,?)",
    )
    .run(
      hash(id),
      userId,
      sessionHash,
      JSON.stringify(request),
      Date.now() + requestMs,
    );
  return id;
}
export function takePendingRequest(
  id: string,
  userId: string,
  sessionHash: string,
): AuthorizationRequest {
  return transaction(() => {
    const row = db()
      .prepare("SELECT * FROM oauth_requests WHERE id=?")
      .get(hash(id)) as
      | {
          user_id: string;
          session_hash: string;
          request: string;
          expires_at: number;
        }
      | undefined;
    if (row)
      db().prepare("DELETE FROM oauth_requests WHERE id=?").run(hash(id));
    if (
      !row ||
      row.expires_at <= Date.now() ||
      row.user_id !== userId ||
      row.session_hash !== sessionHash
    )
      throw new OAuthError(
        "invalid_request",
        "This authorization request has expired. Return to the app and connect again.",
      );
    return JSON.parse(row.request) as AuthorizationRequest;
  });
}

export function issueAuthorizationCode(
  userId: string,
  request: AuthorizationRequest,
) {
  const code = token();
  db().prepare("DELETE FROM oauth_codes WHERE expires_at<=?").run(Date.now());
  db()
    .prepare(
      "INSERT INTO oauth_codes(code_hash,client_id,user_id,redirect_uri,code_challenge,resource,scope,expires_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(
      hash(code),
      request.clientId,
      userId,
      request.redirectUri,
      request.codeChallenge,
      request.resource,
      request.scopes.join(" "),
      Date.now() + codeMs,
    );
  return code;
}

function issueTokens(
  family: string,
  clientId: string,
  userId: string,
  resource: string,
  scope: string,
) {
  const now = Date.now();
  const accessToken = token();
  const refreshToken = token();
  db().prepare("DELETE FROM oauth_tokens WHERE expires_at<=?").run(now);
  const insert = db().prepare(
    "INSERT INTO oauth_tokens(token_hash,kind,family,client_id,user_id,resource,scope,expires_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  insert.run(
    hash(accessToken),
    "access",
    family,
    clientId,
    userId,
    resource,
    scope,
    now + accessTokenSeconds * 1000,
  );
  insert.run(
    hash(refreshToken),
    "refresh",
    family,
    clientId,
    userId,
    resource,
    scope,
    now + refreshTokenMs,
  );
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: accessTokenSeconds,
    refresh_token: refreshToken,
    scope,
  };
}

const grant = (message: string) => new OAuthError("invalid_grant", message);
/** Commits side effects (consumed codes, revoked grants) even when the request then fails. */
function commitOrFail<T>(work: () => T | OAuthError): T {
  const outcome = transaction(work);
  if (outcome instanceof OAuthError) throw outcome;
  return outcome;
}
/** Token endpoint for public clients (token_endpoint_auth_method "none"). */
export async function exchangeToken(form: URLSearchParams) {
  const grantType = single(form, "grant_type");
  const clientId = single(form, "client_id");
  if (!clientId)
    throw new OAuthError("invalid_client", "client_id is required.", 401);
  if (form.has("client_assertion") || form.has("client_secret"))
    throw new OAuthError(
      "invalid_client",
      "Use public-client PKCE (token_endpoint_auth_method none).",
      401,
    );
  await resolveClient(clientId);
  const resource = single(form, "resource");
  if (!sameResource(resource))
    throw new OAuthError(
      "invalid_target",
      "This server only issues tokens for its MCP endpoint.",
    );
  if (grantType === "authorization_code") {
    const code = single(form, "code");
    const redirectUri = single(form, "redirect_uri");
    const verifier = single(form, "code_verifier");
    if (!code || !redirectUri || !verifier)
      throw new OAuthError(
        "invalid_request",
        "code, redirect_uri and code_verifier are required.",
      );
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
      throw grant("The code verifier is malformed.");
    return commitOrFail(() => {
      const row = db()
        .prepare("SELECT * FROM oauth_codes WHERE code_hash=?")
        .get(hash(code)) as
        | {
            client_id: string;
            user_id: string;
            redirect_uri: string;
            code_challenge: string;
            resource: string;
            scope: string;
            expires_at: number;
          }
        | undefined;
      // Codes are single use, including after a failed exchange.
      if (row)
        db()
          .prepare("DELETE FROM oauth_codes WHERE code_hash=?")
          .run(hash(code));
      if (!row || row.expires_at <= Date.now())
        return grant("The authorization code is invalid or expired.");
      if (row.client_id !== clientId || row.redirect_uri !== redirectUri)
        return grant("The authorization code was issued to another client.");
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      if (challenge !== row.code_challenge)
        return grant("The PKCE code verifier does not match.");
      return issueTokens(
        randomUUID(),
        clientId,
        row.user_id,
        row.resource,
        row.scope,
      );
    });
  }
  if (grantType === "refresh_token") {
    const refreshToken = single(form, "refresh_token");
    if (!refreshToken)
      throw new OAuthError("invalid_request", "refresh_token is required.");
    const scopeParam = single(form, "scope");
    return commitOrFail(() => {
      const row = db()
        .prepare(
          "SELECT * FROM oauth_tokens WHERE token_hash=? AND kind='refresh'",
        )
        .get(hash(refreshToken)) as
        | {
            family: string;
            client_id: string;
            user_id: string;
            resource: string;
            scope: string;
            expires_at: number;
            used_at: number | null;
          }
        | undefined;
      if (!row || row.expires_at <= Date.now() || row.client_id !== clientId)
        return grant("The refresh token is invalid or expired.");
      if (row.used_at) {
        // A rotated refresh token was replayed: revoke the whole grant.
        db().prepare("DELETE FROM oauth_tokens WHERE family=?").run(row.family);
        return grant("The refresh token was already used. Reconnect the app.");
      }
      const granted = row.scope.split(" ");
      const scopes = scopeParam
        ? parseScope(scopeParam)
        : (granted as OAuthScope[]);
      if (!scopes || !scopes.every((s) => granted.includes(s)))
        return new OAuthError(
          "invalid_scope",
          "Cannot widen the granted scope.",
        );
      db()
        .prepare("UPDATE oauth_tokens SET used_at=? WHERE token_hash=?")
        .run(Date.now(), hash(refreshToken));
      return issueTokens(
        row.family,
        clientId,
        row.user_id,
        row.resource,
        scopes.join(" "),
      );
    });
  }
  throw new OAuthError(
    "unsupported_grant_type",
    "Use authorization_code or refresh_token.",
  );
}

export type AccessGrant = {
  user: User;
  scopes: OAuthScope[];
  clientId: string;
  token: string;
  expiresAt: number;
};
export function verifyAccessToken(
  header: string | null,
):
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "ok"; grant: AccessGrant } {
  const match = header?.match(/^Bearer ([A-Za-z0-9_-]{20,200})$/i);
  if (!header) return { status: "missing" };
  if (!match) return { status: "invalid" };
  const row = db()
    .prepare(
      "SELECT t.client_id,t.scope,t.expires_at,t.resource,u.id,u.email,u.name,u.role FROM oauth_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.kind='access'",
    )
    .get(hash(match[1])) as
    | (User & {
        client_id: string;
        scope: string;
        expires_at: number;
        resource: string;
      })
    | undefined;
  if (!row || row.expires_at <= Date.now() || row.resource !== mcpResource())
    return { status: "invalid" };
  return {
    status: "ok",
    grant: {
      user: { id: row.id, email: row.email, name: row.name, role: row.role },
      scopes: row.scope.split(" ") as OAuthScope[],
      clientId: row.client_id,
      token: match[1],
      expiresAt: Math.floor(row.expires_at / 1000),
    },
  };
}
