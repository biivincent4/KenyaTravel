import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { samplePackages, type TravelPackage } from "./catalog";
import type { Itinerary, Preferences } from "./validation";

let singleton: DatabaseSync | undefined;
export function db() {
  if (singleton) return singleton;
  const file = resolve(
    /* turbopackIgnore: true */ process.env.DATABASE_PATH ||
      "data\\sanaa.sqlite",
  );
  mkdirSync(dirname(file), { recursive: true });
  const connection = new DatabaseSync(file);
  connection.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('customer','admin')), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS google_accounts (subject TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS google_auth_attempts (state_hash TEXT PRIMARY KEY, verifier TEXT NOT NULL, nonce TEXT NOT NULL, link_user_id TEXT REFERENCES users(id), session_hash TEXT, return_section TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS packages (id TEXT PRIMARY KEY, content TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), source TEXT NOT NULL, preferences TEXT NOT NULL, itinerary TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), plan_id TEXT NOT NULL REFERENCES plans(id),
      status TEXT NOT NULL CHECK(status IN ('requested','quoted','payment_pending','paid')),
      quote_amount INTEGER, quote_currency TEXT, quote_notes TEXT, quote_expires TEXT, quote_version INTEGER NOT NULL DEFAULT 0,
      checkout_session TEXT UNIQUE, checkout_url TEXT, payment_intent TEXT UNIQUE, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id,plan_id)
    );
    CREATE TABLE IF NOT EXISTS enquiries (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), message TEXT NOT NULL, reply TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, processed_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
  `);
  const insert = connection.prepare(
    "INSERT OR IGNORE INTO packages(id,content) VALUES (?,?)",
  );
  for (const item of samplePackages) insert.run(item.id, JSON.stringify(item));
  singleton = connection;
  return connection;
}
export type User = {
  id: string;
  email: string;
  name: string;
  role: "customer" | "admin";
};
export type PlanRow = {
  id: string;
  user_id: string;
  source: "ai" | "catalog";
  preferences: string;
  itinerary: string;
  created_at: string;
};
export type Plan = Omit<PlanRow, "preferences" | "itinerary"> & {
  preferences: Preferences;
  itinerary: Itinerary;
};
export type Booking = {
  id: string;
  user_id: string;
  plan_id: string;
  status: "requested" | "quoted" | "payment_pending" | "paid";
  quote_amount: number | null;
  quote_currency: string | null;
  quote_notes: string | null;
  quote_expires: string | null;
  quote_version: number;
  checkout_session: string | null;
  checkout_url: string | null;
  payment_intent: string | null;
  created_at: string;
  name?: string;
  email?: string;
  title?: string;
};
export type Enquiry = {
  id: string;
  user_id: string;
  message: string;
  reply: string | null;
  created_at: string;
  name?: string;
  email?: string;
};
export function packages(includeInactive = false): TravelPackage[] {
  return (
    db().prepare("SELECT content FROM packages").all() as { content: string }[]
  )
    .map((r) => JSON.parse(r.content) as TravelPackage)
    .filter((p) => includeInactive || p.active);
}
export function parsePlan(row: PlanRow): Plan {
  return {
    ...row,
    preferences: JSON.parse(row.preferences),
    itinerary: JSON.parse(row.itinerary),
  };
}
export function transaction<T>(fn: () => T): T {
  const connection = db();
  connection.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}
export function rateLimit(key: string, max: number, windowSeconds: number) {
  const now = Date.now();
  return transaction(() => {
    db().prepare("DELETE FROM rate_limits WHERE reset_at < ?").run(now);
    db()
      .prepare(
        "INSERT INTO rate_limits(key,count,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
      )
      .run(key, now + windowSeconds * 1000);
    const row = db()
      .prepare("SELECT count FROM rate_limits WHERE key=?")
      .get(key) as { count: number };
    return row.count <= max;
  });
}
