import { randomUUID, randomBytes, scryptSync } from "node:crypto";
import { db } from "../src/lib/db";

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
if (
  !email ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
  !password ||
  password.length < 16 ||
  password.length > 128
) {
  console.error(
    "Set ADMIN_EMAIL to a valid email and ADMIN_PASSWORD to a unique password of 16-128 characters. No default agency account exists.",
  );
  process.exit(1);
}
if (db().prepare("SELECT id FROM users WHERE email=?").get(email)) {
  console.error(
    "An account already exists for this email. No account or role was changed.",
  );
  process.exit(1);
}
const salt = randomBytes(16).toString("hex");
const hash = `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
db()
  .prepare(
    "INSERT INTO users(id,email,name,password_hash,role) VALUES (?,?,?,?,?)",
  )
  .run(randomUUID(), email, "Agency team", hash, "admin");
console.log(
  "Agency administrator created. Sign in using the normal sign-in form.",
);
