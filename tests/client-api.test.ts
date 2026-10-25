import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api, ApiError } from "../src/lib/client-api";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("client requests retain HTTP status and route for auth recovery instead of treating every failure as a generic message", async () => {
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.cache, "no-store");
    return Response.json(
      { error: "Please sign in to continue." },
      { status: 401 },
    );
  };
  await assert.rejects(
    api("ai", { mode: "enquiry", message: "A travel question" }),
    (e: unknown) =>
      e instanceof ApiError && e.status === 401 && e.path === "ai",
  );
  await assert.rejects(
    api("auth/login", {
      email: "fixture@example.test",
      password: "fixture-password",
    }),
    (e: unknown) =>
      e instanceof ApiError && e.status === 401 && e.path === "auth/login",
  );
});
