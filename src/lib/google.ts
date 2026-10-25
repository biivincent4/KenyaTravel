import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { db, transaction } from "./db";
import { AppError } from "./validation";
import { googleErrors } from "./google-messages";
export class GoogleAuthError extends AppError {
  constructor(
    public code: keyof typeof googleErrors,
    status = 400,
  ) {
    super(googleErrors[code], status);
  }
}
export const returnSections = [
  "home",
  "destinations",
  "journeys",
  "planner",
  "trips",
  "contact",
  "agency",
] as const;
export type ReturnSection = (typeof returnSections)[number];
export function applicationOrigin() {
  let base: URL;
  try {
    base = new URL(process.env.APP_URL || "http://localhost:3000");
  } catch {
    throw new GoogleAuthError("unavailable", 503);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    (base.protocol !== "https:" && !(local && base.protocol === "http:"))
  )
    throw new GoogleAuthError("unavailable", 503);
  return base.origin;
}
export function googleConfig() {
  const {
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    APP_URL,
  } = process.env;
  if (
    !clientId?.endsWith(".apps.googleusercontent.com") ||
    !clientSecret ||
    !APP_URL
  )
    throw new GoogleAuthError("unavailable", 503);
  const origin = applicationOrigin();
  return {
    clientId,
    clientSecret,
    origin,
    callbackUrl: `${origin}/api/auth/google/callback`,
  };
}
export function googleReady() {
  try {
    googleConfig();
    return true;
  } catch (error) {
    if (error instanceof GoogleAuthError) return false;
    throw error;
  }
}
export const stateHash = (state: string) =>
  createHash("sha256").update(state).digest("hex");
export type GoogleAttempt = {
  state_hash: string;
  verifier: string;
  nonce: string;
  link_user_id: string | null;
  session_hash: string | null;
  return_section: ReturnSection;
  expires_at: number;
};
export function createGoogleAttempt(
  returnSection: ReturnSection,
  linkUserId: string | null = null,
  session: string | null = null,
  previousState?: string,
) {
  const config = googleConfig();
  if (!returnSections.includes(returnSection))
    throw new AppError("Choose a supported return section.");
  if (linkUserId && !session) throw new GoogleAuthError("session", 401);
  const state = randomBytes(32).toString("hex");
  const verifier = randomBytes(48).toString("base64url");
  const nonce = randomBytes(32).toString("hex");
  transaction(() => {
    db()
      .prepare("DELETE FROM google_auth_attempts WHERE expires_at < ?")
      .run(Date.now());
    if (previousState)
      db()
        .prepare("DELETE FROM google_auth_attempts WHERE state_hash=?")
        .run(stateHash(previousState));
    db()
      .prepare(
        "INSERT INTO google_auth_attempts(state_hash,verifier,nonce,link_user_id,session_hash,return_section,expires_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        stateHash(state),
        verifier,
        nonce,
        linkUserId,
        session,
        returnSection,
        Date.now() + 10 * 60000,
      );
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    prompt: "select_account",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return { state, url: url.href };
}
export function consumeGoogleAttempt(
  state: string | null,
  cookie: string | undefined,
  session: string | null,
) {
  if (
    !state ||
    !cookie ||
    !/^[a-f0-9]{64}$/.test(state) ||
    !/^[a-f0-9]{64}$/.test(cookie) ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(cookie))
  )
    throw new GoogleAuthError("expired");
  return transaction(() => {
    const attempt = db()
      .prepare("SELECT * FROM google_auth_attempts WHERE state_hash=?")
      .get(stateHash(state)) as GoogleAttempt | undefined;
    if (!attempt || attempt.expires_at <= Date.now())
      throw new GoogleAuthError("expired");
    if (attempt.session_hash !== session)
      throw new GoogleAuthError("session", 401);
    db()
      .prepare("DELETE FROM google_auth_attempts WHERE state_hash=?")
      .run(attempt.state_hash);
    return attempt;
  });
}
const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
  { timeoutDuration: 10000 },
);
const identitySchema = z.object({
  sub: z.string().min(1).max(255),
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  email_verified: z.literal(true),
  nonce: z.string(),
  name: z.string().trim().max(500).optional(),
});
export type GoogleIdentity = z.infer<typeof identitySchema>;
export async function verifyGoogleToken(
  token: string,
  nonce: string,
  keys: JWTVerifyGetKey = googleKeys,
): Promise<GoogleIdentity> {
  const config = googleConfig();
  try {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ["RS256"],
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: config.clientId,
      requiredClaims: ["sub", "iat", "exp", "email", "email_verified", "nonce"],
      maxTokenAge: "10m",
      clockTolerance: 5,
    });
    const identity = identitySchema.parse(payload);
    if (
      identity.nonce !== nonce ||
      (payload.azp !== undefined && payload.azp !== config.clientId) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== config.clientId)
    )
      throw new GoogleAuthError("identity");
    return identity;
  } catch {
    throw new GoogleAuthError("identity", 401);
  }
}
export async function exchangeGoogleCode(code: string, attempt: GoogleAttempt) {
  const config = googleConfig();
  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.callbackUrl,
        grant_type: "authorization_code",
        code_verifier: attempt.verifier,
      }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new GoogleAuthError("failed", 502);
    const token = z
      .object({ id_token: z.string().min(1).max(32768) })
      .parse(await response.json());
    return await verifyGoogleToken(token.id_token, attempt.nonce);
  } catch (error) {
    if (error instanceof GoogleAuthError) throw error;
    throw new GoogleAuthError("failed", 502);
  }
}
export function resolveGoogleAccount(
  identity: GoogleIdentity,
  linkUserId: string | null = null,
) {
  const verified = identitySchema.parse(identity);
  return transaction(() => {
    const linked = db()
      .prepare("SELECT user_id FROM google_accounts WHERE subject=?")
      .get(verified.sub) as { user_id: string } | undefined;
    if (linked) {
      if (linkUserId && linked.user_id !== linkUserId)
        throw new GoogleAuthError("link", 409);
      return linked.user_id;
    }
    const existing = db()
      .prepare("SELECT id,email FROM users WHERE email=?")
      .get(verified.email) as { id: string; email: string } | undefined;
    if (linkUserId) {
      if (
        !existing ||
        existing.id !== linkUserId ||
        db()
          .prepare("SELECT subject FROM google_accounts WHERE user_id=?")
          .get(linkUserId)
      )
        throw new GoogleAuthError("link", 409);
      db()
        .prepare("INSERT INTO google_accounts(subject,user_id) VALUES (?,?)")
        .run(verified.sub, linkUserId);
      return linkUserId;
    }
    if (existing) throw new GoogleAuthError("existing", 409);
    const id = randomUUID();
    db()
      .prepare(
        "INSERT INTO users(id,email,name,password_hash,role) VALUES (?,?,?,?,'customer')",
      )
      .run(id, verified.email, verified.name?.slice(0, 80) || "Traveller", "!");
    db()
      .prepare("INSERT INTO google_accounts(subject,user_id) VALUES (?,?)")
      .run(verified.sub, id);
    return id;
  });
}
export function hasGoogleAccount(userId: string) {
  return !!db()
    .prepare("SELECT subject FROM google_accounts WHERE user_id=?")
    .get(userId);
}
