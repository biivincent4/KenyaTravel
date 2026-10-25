import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from "jose";
import { db, type User } from "../src/lib/db";
import { createUser, verifyPassword } from "../src/lib/auth";
import {
  createGoogleAttempt,
  consumeGoogleAttempt,
  googleConfig,
  googleReady,
  hasGoogleAccount,
  resolveGoogleAccount,
  stateHash,
  verifyGoogleToken,
  type GoogleIdentity,
} from "../src/lib/google";
import { dateForDay } from "../src/lib/validation";
import { saveCatalogPlan } from "../src/lib/travel";

const directory = mkdtempSync(join(tmpdir(), "sanaa-google-"));
process.env.DATABASE_PATH = join(directory, "test.sqlite");
process.env.APP_URL = "http://localhost:3000";
process.env.GOOGLE_CLIENT_ID = "fixture-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "fixture-only-not-a-real-secret";
const identity = (sub: string, email: string): GoogleIdentity => ({
  sub,
  email,
  email_verified: true,
  nonce: "fixture-nonce",
  name: "Google visitor",
});
after(() => {
  db().close();
  rmSync(directory, { recursive: true, force: true });
});

test("Google configuration is explicit, rejects remote HTTP and fixes the callback to the application origin", () => {
  assert.equal(
    googleConfig().callbackUrl,
    "http://localhost:3000/api/auth/google/callback",
  );
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_SECRET;
  assert.equal(googleReady(), false);
  assert.throws(() => createGoogleAttempt("trips"), /not configured/);
  process.env.GOOGLE_CLIENT_SECRET = secret;
  for (const url of [
    "http://public.example",
    "https://user:password@example.com",
    "https://example.com/subpath",
    "https://example.com/?next=untrusted",
    "https://example.com/#fragment",
    "invalid",
  ]) {
    process.env.APP_URL = url;
    assert.equal(googleReady(), false);
  }
  process.env.APP_URL = "https://travel.example.test";
  assert.equal(
    googleConfig().callbackUrl,
    "https://travel.example.test/api/auth/google/callback",
  );
  process.env.APP_URL = "http://localhost:3000";
});
test("authorization uses state, nonce and S256 PKCE with minimal scopes and no arbitrary redirect", () => {
  const started = createGoogleAttempt("planner");
  const url = new URL(started.url);
  assert.equal(
    url.origin + url.pathname,
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    googleConfig().callbackUrl,
  );
  assert.equal(url.searchParams.get("state"), started.state);
  assert.equal(url.searchParams.get("access_type"), null);
  const attempt = consumeGoogleAttempt(started.state, started.state, null);
  assert.equal(attempt.return_section, "planner");
  assert.equal(url.searchParams.get("nonce"), attempt.nonce);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("code_challenge"),
    createHash("sha256").update(attempt.verifier).digest("base64url"),
  );
  assert.ok(attempt.verifier.length >= 43 && attempt.verifier.length <= 128);
  assert.throws(
    () => consumeGoogleAttempt(started.state, started.state, null),
    /expired/,
  );
});
test("attempts require the same browser and authenticated session, reject expiry and consume once", () => {
  const started = createGoogleAttempt("trips");
  assert.throws(
    () => consumeGoogleAttempt(started.state, undefined, null),
    /expired/,
  );
  assert.throws(
    () =>
      consumeGoogleAttempt(
        started.state,
        randomBytes(32).toString("hex"),
        null,
      ),
    /expired/,
  );
  assert.throws(
    () => consumeGoogleAttempt("bad-state", "bad-state", null),
    /expired/,
  );
  db()
    .prepare("UPDATE google_auth_attempts SET expires_at=? WHERE state_hash=?")
    .run(Date.now() - 1, stateHash(started.state));
  assert.throws(
    () => consumeGoogleAttempt(started.state, started.state, null),
    /expired/,
  );
  const user = createUser(
    "bound@example.test",
    "Bound customer",
    randomBytes(24).toString("hex"),
  );
  const bound = createGoogleAttempt("trips", user, "original-session");
  assert.throws(
    () => consumeGoogleAttempt(bound.state, bound.state, "different-session"),
    /session changed/,
  );
  assert.equal(
    consumeGoogleAttempt(bound.state, bound.state, "original-session")
      .link_user_id,
    user,
  );
});
test("Google-only sign-up creates a customer without a usable password; repeated subject resolves the same account", () => {
  const profile = identity("google-new", "new@example.test");
  const id = resolveGoogleAccount({ ...profile, ...{ role: "admin" } });
  const row = db().prepare("SELECT * FROM users WHERE id=?").get(id) as User & {
    password_hash: string;
  };
  assert.equal(row.role, "customer");
  assert.equal(row.password_hash, "!");
  assert.equal(
    verifyPassword("not-a-real-account-password", row.password_hash),
    false,
  );
  assert.equal(verifyPassword("anything-at-all", row.password_hash), false);
  assert.equal(hasGoogleAccount(id), true);
  assert.equal(
    resolveGoogleAccount({ ...profile, email: "changed@example.test" }),
    id,
  );
  assert.equal(
    (db().prepare("SELECT email FROM users WHERE id=?").get(id) as User).email,
    "new@example.test",
  );
});
test("matching email never auto-links; explicit linking preserves the original user, password, plans and role", () => {
  const password = randomBytes(24).toString("hex");
  const id = createUser("existing@example.test", "Original visitor", password);
  const before = db()
    .prepare("SELECT * FROM users WHERE id=?")
    .get(id) as User & { password_hash: string };
  const startDate = dateForDay(new Date().toISOString().slice(0, 10), 60);
  const plan = saveCatalogPlan(id, "wild-heart", {
    startDate,
    endDate: dateForDay(startDate, 5),
    partySize: 2,
    budget: 4000,
    currency: "USD",
    interests: ["Wildlife"],
  });
  const profile = identity("google-existing", before.email);
  assert.throws(
    () => resolveGoogleAccount(profile),
    /never linked automatically/,
  );
  assert.equal(hasGoogleAccount(id), false);
  assert.throws(
    () =>
      resolveGoogleAccount(
        identity("wrong-email", "different@example.test"),
        id,
      ),
    /same verified email/,
  );
  assert.equal(resolveGoogleAccount(profile, id), id);
  assert.equal(resolveGoogleAccount(profile), id);
  const after = db()
    .prepare("SELECT * FROM users WHERE id=?")
    .get(id) as User & { password_hash: string };
  assert.deepEqual(after, before);
  assert.equal(verifyPassword(password, after.password_hash), true);
  assert.equal(
    (
      db().prepare("SELECT user_id FROM plans WHERE id=?").get(plan.id) as {
        user_id: string;
      }
    ).user_id,
    id,
  );
  assert.throws(
    () =>
      resolveGoogleAccount(identity("replacement-subject", before.email), id),
    /cannot belong to two/,
  );
  const other = createUser("other@example.test", "Other customer", password);
  assert.throws(
    () => resolveGoogleAccount(profile, other),
    /cannot belong to two/,
  );
});
test("an administrator role is preserved only for an explicitly linked existing administrator", () => {
  const id = createUser(
    "admin-link@example.test",
    "Existing admin",
    randomBytes(24).toString("hex"),
    "admin",
  );
  const profile = identity("google-admin", "admin-link@example.test");
  assert.throws(
    () => resolveGoogleAccount(profile),
    /never linked automatically/,
  );
  assert.equal(resolveGoogleAccount(profile, id), id);
  assert.equal(
    (db().prepare("SELECT role FROM users WHERE id=?").get(id) as User).role,
    "admin",
  );
});
test("Google ID tokens require a valid signature, issuer, audience, nonce, age and verified email", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const wrong = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const keys = createLocalJWKSet({
    keys: [{ ...jwk, kid: "fixture-key", alg: "RS256" }],
  });
  const now = Math.floor(Date.now() / 1000);
  const mint = (claims: JWTPayload = {}, key = privateKey) =>
    new SignJWT({
      iss: "https://accounts.google.com",
      aud: process.env.GOOGLE_CLIENT_ID,
      sub: "signed-google-sub",
      iat: now,
      exp: now + 3600,
      email: "signed@example.test",
      email_verified: true,
      nonce: "expected-nonce",
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
      .sign(key);
  const token = await mint();
  assert.equal(
    (await verifyGoogleToken(token, "expected-nonce", keys)).sub,
    "signed-google-sub",
  );
  await assert.rejects(
    verifyGoogleToken(token, "wrong-nonce", keys),
    /could not verify/,
  );
  for (const patch of [
    { iss: "https://untrusted.example" },
    { aud: "another-client" },
    { aud: [process.env.GOOGLE_CLIENT_ID!, "another-client"] },
    { azp: "another-client" },
    { exp: now - 60 },
    { exp: undefined },
    { iat: now - 1200 },
    { iat: now + 120 },
    { email_verified: false },
    { email: "not-an-email" },
    { sub: "" },
  ])
    await assert.rejects(
      verifyGoogleToken(await mint(patch), "expected-nonce", keys),
      /could not verify/,
    );
  await assert.rejects(
    verifyGoogleToken(await mint({}, wrong.privateKey), "expected-nonce", keys),
    /could not verify/,
  );
  await assert.rejects(
    verifyGoogleToken("not.a.token", "expected-nonce", keys),
    /could not verify/,
  );
});
