import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { askAI } from "../src/lib/ai";
import {
  createPlanDraft,
  ownedDraft,
  ownedPlan,
  requestBooking,
  savePlanDraft,
} from "../src/lib/travel";
import {
  AppError,
  dateForDay,
  type Draft,
  type Preferences,
} from "../src/lib/validation";
import { isSaveItineraryRequest } from "../src/lib/chat-intent";

const directory = mkdtempSync(join(tmpdir(), "sanaa-drafts-"));
process.env.DATABASE_PATH = join(directory, "test.sqlite");
process.env.AI_PROVIDER = "openai";
delete process.env.OPENAI_API_KEY;
const alice = randomUUID();
const bob = randomUUID();
for (const id of [alice, bob])
  db()
    .prepare(
      "INSERT INTO users(id,email,name,password_hash,role) VALUES (?,?,?,'!','customer')",
    )
    .run(id, `${id}@example.test`, "Synthetic visitor");
const startDate = dateForDay(new Date().toISOString().slice(0, 10), 60);
const preferences: Preferences = {
  startDate,
  endDate: dateForDay(startDate, 1),
  partySize: 2,
  budget: 4000,
  currency: "USD",
  interests: ["Nature"],
};
const input: Draft = {
  title: "A quiet Nairobi introduction",
  summary:
    "Two illustrative days exploring the agency's curated Nairobi experiences.",
  days: [1, 2].map((day) => ({
    day,
    destinationId: "nairobi",
    activityIds: ["nairobi-museum"],
    travelOnly: false,
  })),
};
after(() => {
  db().close();
  rmSync(directory, { recursive: true, force: true });
});

test("save intent is explicit and never confuses enquiries, negations or booking requests with saving", () => {
  for (const text of [
    "save my itinerary",
    "Please save this plan!",
    "Could you save my itinerary?",
    "save it",
    "save this to my trips",
    "save itinerary please",
    "save my itinery",
  ])
    assert.equal(isSaveItineraryRequest(text), true, text);
  for (const text of [
    "How can I save money?",
    "Do not save my itinerary",
    "Please don't save it",
    "save my itinerary and book it",
    "Can I save an itinerary later?",
    "a saved plan",
  ])
    assert.equal(isSaveItineraryRequest(text), false, text);
});

test("working drafts are validated, owner-scoped and not bookable; explicit save preserves the server snapshot and is idempotent", () => {
  const draft = createPlanDraft(alice, preferences, input);
  const snapshot = structuredClone(draft);
  assert.throws(() => ownedPlan(alice, draft.id), /not found/);
  assert.throws(() => requestBooking(alice, draft.id), /not found/);
  assert.throws(() => ownedDraft(bob, draft.id), /not found/);
  assert.throws(() => savePlanDraft(bob, draft.id), /not found/);
  draft.itinerary.title = "Untrusted browser changes";
  draft.preferences.budget = 1;
  const plan = savePlanDraft(alice, draft.id);
  assert.deepEqual(plan.itinerary, snapshot.itinerary);
  assert.deepEqual(plan.preferences, snapshot.preferences);
  assert.equal(savePlanDraft(alice, draft.id).id, plan.id);
  assert.equal(requestBooking(alice, plan.id).status, "requested");
  assert.throws(() => requestBooking(bob, plan.id), /not found/);
  db().prepare("UPDATE plan_drafts SET expires_at=0 WHERE id=?").run(draft.id);
  assert.equal(savePlanDraft(alice, draft.id).id, plan.id);
});

test("invalid and expired unsaved drafts cannot be promoted or booked", () => {
  assert.throws(
    () =>
      createPlanDraft(alice, preferences, {
        ...input,
        days: input.days.map((day) => ({ ...day, activityIds: ["invented"] })),
      }),
    /not in the agency catalog/,
  );
  const draft = createPlanDraft(alice, preferences, input);
  db().prepare("UPDATE plan_drafts SET expires_at=0 WHERE id=?").run(draft.id);
  assert.throws(
    () => savePlanDraft(alice, draft.id),
    (e: unknown) => e instanceof AppError && e.status === 410,
  );
  assert.throws(() => ownedPlan(alice, draft.id), /not found/);
});

test("chat save requests use authenticated backend saving without provider calls or configuration", async () => {
  const draft = createPlanDraft(alice, preferences, input);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("No model call is allowed for saving");
  };
  try {
    await assert.rejects(
      askAI(
        bob,
        "enquiry",
        "save my itinerary",
        undefined,
        undefined,
        draft.id,
      ),
      /not found/,
    );
    const result = await askAI(
      alice,
      "enquiry",
      "please save my itinerary",
      undefined,
      undefined,
      draft.id,
    );
    assert.ok(result.plan);
    assert.match(result.answer!, /saved privately in My trips/);
    const repeat = await askAI(
      alice,
      "plan",
      "save it",
      undefined,
      undefined,
      draft.id,
    );
    assert.equal(repeat.plan!.id, result.plan.id);
    const already = await askAI(
      alice,
      "enquiry",
      "save it",
      undefined,
      result.plan.id,
    );
    assert.equal(already.plan!.id, result.plan.id);
    assert.match(already.answer!, /already saved/);
    await assert.rejects(
      askAI(alice, "enquiry", "save my itinerary"),
      /Create an itinerary first/,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
