import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
  randomUUID,
} from "node:crypto";
import { cookies } from "next/headers";
import { db, type User } from "./db";
import { AppError } from "./validation";

const cookieName = "sanaa_session";
export const googleCookieName = "sanaa_google_oauth";
export const googleCookiePath = "/api/auth/google";
export const secureCookies = () =>
  process.env.APP_URL?.startsWith("https://") ||
  process.env.COOKIE_SECURE === "true";
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password: string, hash: string) {
  if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash)) return false;
  const [salt, value] = hash.split(":");
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(value, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function sessionHash() {
  const token = (await cookies()).get(cookieName)?.value;
  return token ? digest(token) : null;
}
export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(cookieName)?.value;
  if (!token) return null;
  return (
    (db()
      .prepare(
        "SELECT u.id,u.email,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?",
      )
      .get(digest(token), Date.now()) as User | undefined) ?? null
  );
}
export async function requireUser(admin = false) {
  const user = await currentUser();
  if (!user) throw new AppError("Please sign in to continue.", 401);
  if (admin && user.role !== "admin")
    throw new AppError("Agency access is required.", 403);
  return user;
}
export async function createSession(userId: string) {
  const jar = await cookies();
  const oldToken = jar.get(cookieName)?.value;
  if (oldToken)
    db()
      .prepare("DELETE FROM sessions WHERE token_hash=?")
      .run(digest(oldToken));
  db().prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  const token = randomBytes(32).toString("hex");
  db()
    .prepare(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)",
    )
    .run(digest(token), userId, Date.now() + 7 * 86400000);
  jar.set(cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    maxAge: 7 * 86400,
  });
}
export async function logout() {
  const jar = await cookies();
  const token = jar.get(cookieName)?.value;
  if (token)
    db().prepare("DELETE FROM sessions WHERE token_hash=?").run(digest(token));
  const googleState = jar.get(googleCookieName)?.value;
  if (googleState)
    db()
      .prepare("DELETE FROM google_auth_attempts WHERE state_hash=?")
      .run(digest(googleState));
  if (token)
    db()
      .prepare("DELETE FROM google_auth_attempts WHERE session_hash=?")
      .run(digest(token));
  jar.set(googleCookieName, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: googleCookiePath,
    maxAge: 0,
  });
  jar.delete(cookieName);
}
export function createUser(
  email: string,
  name: string,
  password: string,
  role: User["role"] = "customer",
) {
  const id = randomUUID();
  db()
    .prepare(
      "INSERT INTO users(id,email,name,password_hash,role) VALUES (?,?,?,?,?)",
    )
    .run(id, email, name, hashPassword(password), role);
  return id;
}
