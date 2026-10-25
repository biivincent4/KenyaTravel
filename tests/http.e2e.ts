import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createUser } from "../src/lib/auth";
import { db } from "../src/lib/db";
import { dateForDay } from "../src/lib/validation";
import { resolveGoogleAccount } from "../src/lib/google";

async function main() {
  const port = 3017;
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, () => probe.close(() => resolve()));
  });
  const directory = mkdtempSync(join(tmpdir(), "sanaa-http-"));
  process.env.DATABASE_PATH = join(directory, "http.sqlite");
  const password = randomBytes(24).toString("hex");
  createUser("agency@example.test", "Test agency", password, "admin");
  resolveGoogleAccount({
    sub: "http-google-only",
    email: "google-only@example.test",
    email_verified: true,
    nonce: "fixture",
    name: "Google-only visitor",
  });
  const origin = `http://localhost:${port}`;
  const child = spawn(
    process.execPath,
    ["node_modules\\next\\dist\\bin\\next", "start", "--port", String(port)],
    {
      env: {
        ...process.env,
        APP_URL: origin,
        OPENAI_API_KEY: "",
        OPENAI_MODEL: "",
        AI_PROVIDER: "openai",
        AZURE_OPENAI_ENDPOINT: "",
        AZURE_OPENAI_API_KEY: "",
        AZURE_OPENAI_DEPLOYMENT: "",
        STRIPE_SECRET_KEY: "",
        STRIPE_WEBHOOK_SECRET: "",
        COOKIE_SECURE: "false",
        GOOGLE_CLIENT_ID: "http-fixture.apps.googleusercontent.com",
        GOOGLE_CLIENT_SECRET: "fixture-only-not-a-real-secret",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (data) => {
    output += data.toString();
  });
  child.stderr?.on("data", (data) => {
    output += data.toString();
  });
  function client() {
    const jar = new Map<string, string>();
    const cookieHeader = () =>
      [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    function applyCookies(response: Response) {
      for (const setCookie of response.headers.getSetCookie()) {
        const pair = setCookie.split(";")[0];
        const index = pair.indexOf("=");
        const name = pair.slice(0, index),
          value = pair.slice(index + 1);
        if (value) {
          assert.match(setCookie, /httponly/i);
          assert.match(setCookie, /samesite=lax/i);
          jar.set(name, value);
        } else jar.delete(name);
      }
    }
    const request = async (
      path: string,
      data?: object,
      expected = 200,
      from = origin,
    ) => {
      const response = await fetch(`${origin}/api/${path}`, {
        method: data ? "POST" : "GET",
        headers: {
          ...(data ? { "Content-Type": "application/json", Origin: from } : {}),
          ...(jar.size ? { Cookie: cookieHeader() } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
      });
      applyCookies(response);
      const body = await response.json();
      assert.equal(
        response.status,
        expected,
        `${path}: ${JSON.stringify(body)}`,
      );
      return body;
    };
    return Object.assign(request, {
      callback: async (query: string, expectedCode: string) => {
        const response = await fetch(
          `${origin}/api/auth/google/callback?${query}`,
          { redirect: "manual", headers: { Cookie: cookieHeader() } },
        );
        assert.equal(response.status, 303);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("referrer-policy"), "no-referrer");
        const location = new URL(response.headers.get("location")!);
        assert.equal(location.origin, origin);
        assert.equal(location.searchParams.get("googleError"), expectedCode);
        applyCookies(response);
        return location;
      },
    });
  }
  try {
    let responsive = false;
    for (let i = 0; i < 90; i++) {
      try {
        const response = await fetch(`${origin}/api/session`);
        if (response.ok) {
          responsive = true;
          break;
        }
      } catch {
        /* The isolated test server is still starting. */
      }
      if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(responsive, `Server not ready: ${output}`);
    const visitor = client(),
      alice = client(),
      bob = client(),
      admin = client();
    const publicSession = await visitor("session");
    assert.equal(publicSession.user, null);
    assert.equal(publicSession.aiReady, false);
    assert.equal(publicSession.paymentReady, false);
    assert.equal(publicSession.googleReady, true);
    assert.equal(publicSession.googleLinked, false);
    await visitor(
      "auth/google/start",
      { intent: "signin" },
      403,
      "https://untrusted.example",
    );
    await visitor(
      "auth/google/start",
      { intent: "signin", returnSection: "//untrusted.example" },
      400,
    );
    await visitor("auth/google/start", { intent: "link", password }, 401);
    const started = new URL(
      (
        await visitor("auth/google/start", {
          intent: "signin",
          returnSection: "planner",
        })
      ).url,
    );
    const state = started.searchParams.get("state")!;
    assert.equal(
      started.searchParams.get("redirect_uri"),
      `${origin}/api/auth/google/callback`,
    );
    await visitor.callback(
      `state=${"0".repeat(64)}&error=access_denied`,
      "expired",
    );
    const denied = await visitor.callback(
      `state=${state}&error=access_denied`,
      "denied",
    );
    assert.equal(denied.hash, "#planner");
    await visitor.callback(`state=${state}&code=replayed`, "expired");
    assert.equal((await visitor("session")).user, null);
    await visitor(
      "auth/login",
      {
        email: "google-only@example.test",
        password: "not-a-real-account-password",
      },
      401,
    );
    await visitor("trips", undefined, 401);
    await visitor(
      "auth/register",
      { email: "attacker@example.test", name: "Cross origin", password },
      403,
      "https://untrusted.example",
    );
    await alice("auth/register", {
      email: "alice@example.test",
      name: "Alice",
      password,
      role: "admin",
    });
    assert.equal((await alice("session")).user.role, "customer");
    await bob("auth/register", {
      email: "bob@example.test",
      name: "Bob",
      password,
    });
    await admin("auth/login", { email: "agency@example.test", password });
    await alice("admin/overview", undefined, 403);
    await alice("auth/google/start", { intent: "signin" }, 409);
    await alice(
      "auth/google/start",
      { intent: "link", password: "incorrect-password" },
      401,
    );
    const link = new URL(
      (
        await alice("auth/google/start", {
          intent: "link",
          password,
          returnSection: "trips",
        })
      ).url,
    );
    await bob.callback(
      `state=${link.searchParams.get("state")}&error=access_denied`,
      "expired",
    );
    await alice.callback(
      `state=${link.searchParams.get("state")}&error=access_denied`,
      "denied",
    );
    assert.equal((await alice("session")).user.role, "customer");
    assert.equal((await alice("session")).googleLinked, false);
    const adminLink = new URL(
      (
        await admin("auth/google/start", {
          intent: "link",
          password,
          returnSection: "agency",
        })
      ).url,
    );
    await admin.callback(
      `state=${adminLink.searchParams.get("state")}&error=access_denied`,
      "denied",
    );
    assert.equal((await admin("session")).user.role, "admin");
    const startDate = dateForDay(new Date().toISOString().slice(0, 10), 90);
    const preferences = {
      startDate,
      endDate: dateForDay(startDate, 5),
      partySize: 2,
      budget: 4000,
      currency: "USD",
      interests: ["Wildlife", "Nature"],
    };
    await alice(
      "plans/catalog",
      {
        packageId: "wild-heart",
        preferences: { ...preferences, endDate: startDate },
      },
      400,
    );
    const { plan } = await alice(
      "plans/catalog",
      { packageId: "wild-heart", preferences },
      201,
    );
    assert.equal(plan.itinerary.days.length, 6);
    assert.equal(plan.itinerary.estimate.amount, 2600);
    await bob("bookings", { planId: plan.id }, 404);
    const { booking } = await alice(
      "bookings",
      { planId: plan.id, amount: 1, status: "paid" },
      201,
    );
    assert.equal(booking.status, "requested");
    assert.equal(booking.quote_amount, null);
    assert.equal(
      (await alice("bookings", { planId: plan.id }, 201)).booking.id,
      booking.id,
    );
    await alice(
      "admin/quote",
      {
        bookingId: booking.id,
        amount: 1,
        currency: "USD",
        notes: "Unprivileged quote attempt",
        expiresAt: startDate,
      },
      403,
    );
    assert.equal((await bob("trips")).plans.length, 0);
    assert.equal((await bob("trips")).bookings.length, 0);
    await alice(
      "enquiries",
      { message: "Can the agency confirm the included road transfers?" },
      201,
    );
    const overview = await admin("admin/overview");
    assert.equal(overview.bookings.length, 1);
    assert.equal(overview.plans[0].id, plan.id);
    await admin("admin/reply", {
      id: overview.enquiries[0].id,
      reply:
        "We will check availability and include all confirmed transfers in your quote.",
    });
    assert.match(
      (await alice("trips")).enquiries[0].reply,
      /check availability/,
    );
    await admin("admin/quote", {
      bookingId: booking.id,
      amount: 2600.25,
      currency: "USD",
      notes:
        "TEST: checked availability; six days, accommodation and listed road transfers. Excludes flights and insurance. Cancellation terms: test only, no real reservation.",
      expiresAt: dateForDay(startDate, -1),
    });
    const quoted = (await alice("trips")).bookings[0];
    assert.equal(quoted.status, "quoted");
    assert.equal(quoted.quote_amount, 260025);
    await alice("checkout", { bookingId: booking.id, amount: 1 }, 503);
    assert.equal((await alice("trips")).bookings[0].status, "quoted");
    await alice(
      "ai",
      { mode: "plan", message: "Please make my Kenya plan", preferences },
      503,
    );
    await admin("admin/package", {
      id: "coastal-slow",
      description:
        "A new illustrative coastal description maintained by the agency team.",
      active: false,
    });
    assert.equal((await visitor("catalog")).packages.length, 2);
    const pending = new URL(
      (await alice("auth/google/start", { intent: "link", password })).url,
    );
    await alice("auth/logout", {});
    await alice.callback(
      `state=${pending.searchParams.get("state")}&error=access_denied`,
      "expired",
    );
    await alice("trips", undefined, 401);
    console.log(
      "HTTP end-to-end passed: origin guard, customer/admin authentication, Google OAuth start/cancellation/replay/session-binding/link reauthentication/logout safeguards, Google-only password denial, role escalation rejection, ownership, saved itinerary, booking idempotency, enquiry/reply, agency quote, missing-provider safeguards and catalog management.",
    );
  } finally {
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    db().close();
    rmSync(directory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
