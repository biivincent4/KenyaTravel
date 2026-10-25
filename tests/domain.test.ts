import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { db, packages, type Booking } from "../src/lib/db";
import { hashPassword, verifyPassword } from "../src/lib/auth";
import {
  preferenceSchema,
  validateItinerary,
  dateForDay,
  type Preferences,
  type Draft,
} from "../src/lib/validation";
import {
  issueQuote,
  requestBooking,
  saveCatalogPlan,
  ownedPlan,
} from "../src/lib/travel";
import {
  applyPaymentEvent,
  verifyWebhook,
  createCheckout,
  type PaymentEvent,
} from "../src/lib/payments";
import { askAI } from "../src/lib/ai";
import { destinations, transferHours } from "../src/lib/catalog";

const directory = mkdtempSync(join(tmpdir(), "sanaa-domain-"));
process.env.DATABASE_PATH = join(directory, "test.sqlite");
process.env.AI_PROVIDER = "openai";
const startDate = dateForDay(new Date().toISOString().slice(0, 10), 90);
const prefs: Preferences = {
  startDate,
  endDate: dateForDay(startDate, 5),
  partySize: 2,
  budget: 5000,
  currency: "USD",
  interests: ["Wildlife"],
};
const alice = randomUUID(),
  bob = randomUUID();
db()
  .prepare(
    "INSERT INTO users(id,email,name,password_hash,role) VALUES (?,?,?,?,'customer')",
  )
  .run(alice, "alice@example.test", "Alice", "unused-test-fixture");
db()
  .prepare(
    "INSERT INTO users(id,email,name,password_hash,role) VALUES (?,?,?,?,'customer')",
  )
  .run(bob, "bob@example.test", "Bob", "unused-test-fixture");
after(() => {
  db().close();
  rmSync(directory, { recursive: true, force: true });
});

test("passwords use independent salts and constant-time verifiable hashes", () => {
  const hash = hashPassword("a-unique-test-password");
  assert.notEqual(hash, hashPassword("a-unique-test-password"));
  assert.equal(verifyPassword("a-unique-test-password", hash), true);
  assert.equal(verifyPassword("incorrect-password", hash), false);
});
test("preferences reject invalid calendar dates, past dates, reversed dates, long duration and invalid party sizes", () => {
  for (const patch of [
    { startDate: "2028-02-30" },
    { startDate: "2020-01-01" },
    { endDate: dateForDay(startDate, -1) },
    { endDate: dateForDay(startDate, 14) },
    { partySize: 0 },
    { partySize: 13 },
    { interests: [] },
    { currency: "EUR" },
  ])
    assert.equal(
      preferenceSchema.safeParse({ ...prefs, ...patch }).success,
      false,
    );
});
test("every catalog destination pair has a symmetric, explicit transfer estimate", () => {
  for (const from of destinations)
    for (const to of destinations) {
      assert.equal(
        transferHours(from.id, to.id),
        transferHours(to.id, from.id),
      );
      assert.ok(transferHours(from.id, to.id) < 24);
    }
});
test("all seeded routes validate with exact dates and server-owned estimates", () => {
  for (const item of packages()) {
    const p = { ...prefs, endDate: dateForDay(startDate, item.days - 1) };
    const saved = saveCatalogPlan(alice, item.id, p);
    assert.equal(saved.itinerary.days.length, item.days);
    assert.equal(saved.itinerary.days.at(-1)?.date, p.endDate);
    assert.ok(saved.itinerary.estimate.amount > 0);
    assert.equal(saved.source, "catalog");
  }
  const usd = saveCatalogPlan(alice, "wild-heart", prefs);
  assert.equal(usd.itinerary.estimate.amount, 2600);
  const kes = saveCatalogPlan(alice, "wild-heart", {
    ...prefs,
    currency: "KES",
    budget: 1000,
  });
  assert.equal(kes.itinerary.estimate.amount, 338000);
  assert.equal(kes.itinerary.estimate.withinBudget, false);
  assert.throws(
    () =>
      saveCatalogPlan(alice, "wild-heart", {
        ...prefs,
        endDate: dateForDay(startDate, 3),
      }),
    /exactly 6 days/,
  );
});
test("structured plans reject hallucinations, invalid ordering, duplication and impossible road schedules", () => {
  const draft: Draft = {
    title: "Sample Kenya",
    summary: "A catalog-grounded sample trip.",
    days: [
      {
        day: 1,
        destinationId: "nairobi",
        activityIds: ["nairobi-food"],
        travelOnly: false,
      },
      {
        day: 2,
        destinationId: "naivasha",
        activityIds: ["naivasha-walk"],
        travelOnly: false,
      },
    ],
  };
  const p = { ...prefs, endDate: dateForDay(startDate, 1) };
  assert.equal(validateItinerary(draft, p).days[1].transferHours, 2.5);
  assert.throws(
    () =>
      validateItinerary(
        {
          ...draft,
          days: [
            { ...draft.days[0], destinationId: "invented" },
            draft.days[1],
          ],
        },
        p,
      ),
    /unknown destination/,
  );
  assert.throws(
    () =>
      validateItinerary(
        {
          ...draft,
          days: [
            { ...draft.days[0], activityIds: ["invented"] },
            draft.days[1],
          ],
        },
        p,
      ),
    /not in the agency catalog/,
  );
  assert.throws(
    () =>
      validateItinerary(
        {
          ...draft,
          days: [
            { ...draft.days[0], activityIds: ["nairobi-food", "nairobi-food"] },
            draft.days[1],
          ],
        },
        p,
      ),
    /repeated/,
  );
  assert.throws(
    () =>
      validateItinerary(
        { ...draft, days: [draft.days[0], { ...draft.days[1], day: 3 }] },
        p,
      ),
    /out-of-order/,
  );
  assert.throws(() => validateItinerary(draft, prefs), /does not match/);
  assert.throws(
    () =>
      validateItinerary(
        {
          ...draft,
          days: [
            {
              ...draft.days[0],
              destinationId: "mara",
              activityIds: ["mara-drive"],
            },
            {
              ...draft.days[1],
              destinationId: "diani",
              activityIds: [],
              travelOnly: true,
            },
          ],
        },
        p,
      ),
    /too long/,
  );
  assert.throws(
    () =>
      validateItinerary(
        {
          ...draft,
          days: [
            draft.days[0],
            {
              ...draft.days[1],
              destinationId: "diani",
              activityIds: ["diani-beach"],
            },
          ],
        },
        p,
      ),
    /too little time/,
  );
  assert.throws(
    () =>
      validateItinerary(
        {
          ...draft,
          days: [
            draft.days[0],
            {
              ...draft.days[1],
              destinationId: "amboseli",
              activityIds: ["amboseli-drive", "amboseli-view"],
            },
          ],
        },
        p,
      ),
    /too little time/,
  );
  assert.equal(
    validateItinerary(
      {
        ...draft,
        days: [
          draft.days[0],
          {
            ...draft.days[1],
            destinationId: "diani",
            activityIds: [],
            travelOnly: true,
          },
        ],
      },
      p,
    ).days[1].transferHours,
    10,
  );
});
test("saved plans and bookings enforce ownership and idempotent requests", () => {
  const plan = saveCatalogPlan(alice, "wild-heart", prefs);
  assert.throws(() => ownedPlan(bob, plan.id), /not found/);
  assert.throws(() => requestBooking(bob, plan.id), /not found/);
  const b = requestBooking(alice, plan.id);
  assert.equal(requestBooking(alice, plan.id).id, b.id);
  assert.equal(b.status, "requested");
  assert.equal(b.quote_amount, null);
});
function quotedBooking() {
  const plan = saveCatalogPlan(alice, "wild-heart", prefs);
  const b = requestBooking(alice, plan.id);
  return issueQuote(
    b.id,
    1234.56,
    "USD",
    "Test availability checked, inclusions and cancellation terms.",
    dateForDay(startDate, -2),
  );
}
function reserve(b: Booking) {
  db()
    .prepare(
      "UPDATE bookings SET status='payment_pending',checkout_session=?,checkout_url=? WHERE id=?",
    )
    .run(`cs_test_${b.id}`, "https://checkout.stripe.com/test-fixture", b.id);
  return db().prepare("SELECT * FROM bookings WHERE id=?").get(b.id) as Booking;
}
function paymentEvent(
  b: Booking,
  type = "checkout.session.completed",
  patches: object = {},
  id = randomUUID(),
): PaymentEvent {
  const event = {
    id,
    object: "event",
    type,
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    pending_webhooks: 1,
    request: null,
    api_version: null,
    data: {
      object: {
        id: b.checkout_session,
        object: "checkout.session",
        metadata: { bookingId: b.id, quoteVersion: String(b.quote_version) },
        amount_total: b.quote_amount,
        currency: b.quote_currency!.toLowerCase(),
        payment_status: "paid",
        payment_intent: `pi_${b.id}`,
        ...patches,
      },
    },
  };
  return event;
}
test("quotes persist minor units, reject precision and expiry errors, and lock during checkout", () => {
  const b = quotedBooking();
  assert.equal(b.status, "quoted");
  assert.equal(b.quote_amount, 123456);
  assert.throws(
    () => issueQuote(b.id, 1.111, "USD", "Valid quote notes", startDate),
    /two decimal/,
  );
  assert.throws(
    () =>
      issueQuote(
        b.id,
        100,
        "USD",
        "Valid quote notes",
        dateForDay(startDate, 1),
      ),
    /no later/,
  );
  assert.throws(
    () => issueQuote(b.id, 100, "USD", "Valid quote notes", "2020-01-01"),
    /today or later/,
  );
  reserve(b);
  assert.throws(
    () => issueQuote(b.id, 10, "USD", "Valid quote notes", startDate),
    /cannot be re-quoted/,
  );
});
test("missing Stripe configuration never changes quote to pending or paid", async () => {
  delete process.env.STRIPE_SECRET_KEY;
  const b = quotedBooking();
  await assert.rejects(createCheckout(alice, b.id), /not configured/);
  assert.equal(
    (
      db()
        .prepare("SELECT status FROM bookings WHERE id=?")
        .get(b.id) as Booking
    ).status,
    "quoted",
  );
});
test("hosted checkout uses server quote amounts, expires with the quote and reuses its idempotent reservation", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fixture_not_a_real_key";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_fixture_not_a_real_secret";
  process.env.APP_URL = "http://localhost:3000";
  const b = quotedBooking();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(String(url), "https://api.stripe.com/v1/checkout/sessions");
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("line_items[0][price_data][unit_amount]"), "123456");
    assert.equal(form.get("line_items[0][price_data][currency]"), "usd");
    assert.equal(form.get("metadata[bookingId]"), b.id);
    assert.equal(form.get("metadata[quoteVersion]"), String(b.quote_version));
    assert.equal(
      new Headers(init?.headers).get("Idempotency-Key"),
      `booking-${b.id}-quote-${b.quote_version}`,
    );
    assert.ok(
      Number(form.get("expires_at")) <=
        Date.parse(`${b.quote_expires}T23:59:59Z`) / 1000,
    );
    assert.ok(Number(form.get("expires_at")) <= Date.now() / 1000 + 86400);
    return Response.json({
      id: `cs_test_${b.id}`,
      object: "checkout.session",
      livemode: false,
      url: "https://checkout.stripe.com/test-checkout-fixture",
    });
  };
  try {
    assert.equal(
      await createCheckout(alice, b.id),
      "https://checkout.stripe.com/test-checkout-fixture",
    );
    assert.equal(
      await createCheckout(alice, b.id),
      "https://checkout.stripe.com/test-checkout-fixture",
    );
    assert.equal(requests, 1);
    const stored = db()
      .prepare("SELECT * FROM bookings WHERE id=?")
      .get(b.id) as Booking;
    assert.equal(stored.status, "payment_pending");
    assert.equal(stored.quote_amount, 123456);
    await assert.rejects(createCheckout(bob, b.id), /not found/);
    applyPaymentEvent(paymentEvent(stored));
    assert.equal(
      (
        db()
          .prepare("SELECT status FROM bookings WHERE id=?")
          .get(b.id) as Booking
      ).status,
      "paid",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("verified payment events are amount-bound, version-bound, idempotent and cannot be forged by redirects", () => {
  const b = reserve(quotedBooking());
  assert.throws(
    () => applyPaymentEvent(paymentEvent(b, undefined, { amount_total: 1 })),
    /amount or currency/,
  );
  assert.throws(
    () => applyPaymentEvent(paymentEvent(b, undefined, { currency: "kes" })),
    /amount or currency/,
  );
  assert.throws(
    () =>
      applyPaymentEvent(
        paymentEvent(b, undefined, {
          metadata: { bookingId: b.id, quoteVersion: "999" },
        }),
      ),
    /does not match/,
  );
  assert.throws(
    () =>
      applyPaymentEvent(paymentEvent(b, undefined, { id: "wrong-session" })),
    /does not match/,
  );
  const unpaid = paymentEvent(b, undefined, {
    payment_status: "unpaid",
    payment_intent: null,
  });
  applyPaymentEvent(unpaid);
  assert.equal(
    (
      db()
        .prepare("SELECT status FROM bookings WHERE id=?")
        .get(b.id) as Booking
    ).status,
    "payment_pending",
  );
  const event = paymentEvent(b, "checkout.session.async_payment_succeeded");
  assert.equal(applyPaymentEvent(event).duplicate, false);
  assert.equal(applyPaymentEvent(event).duplicate, true);
  assert.equal(
    (
      db()
        .prepare("SELECT status FROM bookings WHERE id=?")
        .get(b.id) as Booking
    ).status,
    "paid",
  );
  assert.throws(
    () => issueQuote(b.id, 10, "USD", "Valid quote notes", startDate),
    /cannot be re-quoted/,
  );
  assert.throws(
    () => applyPaymentEvent({ ...event, id: randomUUID(), livemode: true }),
    /Live payment events/,
  );
});
test("expiry releases checkout once, and stale events cannot update a new attempt", () => {
  const b = reserve(quotedBooking());
  const event = paymentEvent(b, "checkout.session.expired", {
    payment_status: "unpaid",
    payment_intent: null,
  });
  applyPaymentEvent(event);
  const released = db()
    .prepare("SELECT * FROM bookings WHERE id=?")
    .get(b.id) as Booking;
  assert.equal(released.status, "quoted");
  assert.equal(released.checkout_session, null);
  assert.equal(released.quote_version, b.quote_version + 1);
  assert.equal(applyPaymentEvent(event).duplicate, true);
  assert.throws(() => applyPaymentEvent(paymentEvent(b)), /does not match/);
});
test("Stripe signature verification accepts valid test signatures and rejects tampered payloads", () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fixture_not_a_real_key";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_fixture_not_a_real_secret";
  process.env.APP_URL = "http://localhost:3000";
  const event = paymentEvent(reserve(quotedBooking()));
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });
  assert.equal(verifyWebhook(payload, signature).id, event.id);
  assert.throws(
    () => verifyWebhook(payload + " ", signature),
    /Invalid Stripe/,
  );
});
test("AI unavailable state is explicit and catalog tool use is mandatory", async () => {
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(
    askAI(alice, "enquiry", "Where can we go?"),
    /AI is not connected/,
  );
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-fixture-not-a-real-key";
  process.env.OPENAI_MODEL = "test-model";
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    return Response.json({
      choices: [
        {
          message:
            requests.length === 1
              ? {
                  content: null,
                  tool_calls: [
                    {
                      id: "catalog-call",
                      type: "function",
                      function: { name: "lookup_catalog", arguments: "{}" },
                    },
                  ],
                }
              : {
                  content: JSON.stringify({
                    answer:
                      "Our curated Maasai Mara route is an illustrative wildlife option. Availability needs agency confirmation.",
                  }),
                },
        },
      ],
    });
  };
  try {
    const response = await askAI(
      alice,
      "enquiry",
      "Where can we see wildlife?",
    );
    assert.match(response.answer!, /Maasai Mara/);
    assert.equal(requests.length, 2);
    const messages = requests[1].messages as {
      role: string;
      content: string;
    }[];
    const tool = messages.find((m) => m.role === "tool");
    assert.ok(tool);
    assert.ok(JSON.parse(tool.content).destinations.length >= 5);
    globalThis.fetch = async () =>
      Response.json({
        choices: [{ message: { content: "I did not use tools" } }],
      });
    await assert.rejects(
      askAI(alice, "enquiry", "Find a trip"),
      /did not ground/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
  }
});
test("AI planning persists only validated structured output and keeps refinements owner-bound", async () => {
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-fixture-not-a-real-key";
  process.env.OPENAI_MODEL = "test-model";
  const catalog = saveCatalogPlan(alice, "wild-heart", prefs);
  const draft: Draft = {
    title: "A quieter Kenya adventure",
    summary:
      "A sample catalog-grounded journey with slow mornings and wildlife time.",
    days: catalog.itinerary.days.map(
      ({ day, destinationId, activityIds, travelOnly }) => ({
        day,
        destinationId,
        activityIds,
        travelOnly,
      }),
    ),
  };
  let count = 0;
  globalThis.fetch = async () =>
    Response.json({
      choices: [
        {
          message:
            ++count % 2
              ? {
                  content: null,
                  tool_calls: [
                    {
                      id: "catalog-lookup",
                      type: "function",
                      function: { name: "lookup_catalog", arguments: "{}" },
                    },
                  ],
                }
              : { content: JSON.stringify(draft) },
        },
      ],
    });
  try {
    const result = await askAI(
      alice,
      "plan",
      "Wildlife and quiet mornings",
      prefs,
      catalog.id,
    );
    assert.ok(result.plan);
    assert.equal(result.plan.source, "ai");
    assert.equal(result.plan.itinerary.estimate.amount, 2600);
    assert.notEqual(result.plan.id, catalog.id);
    assert.equal(ownedPlan(alice, result.plan.id).itinerary.days.length, 6);
    await assert.rejects(
      askAI(bob, "plan", "Refine this", prefs, catalog.id),
      /not found/,
    );
    const before = db().prepare("SELECT count(*) count FROM plans").get() as {
      count: number;
    };
    draft.days[0].activityIds = ["invented-activity"];
    await assert.rejects(
      askAI(alice, "plan", "Make another plan", prefs),
      /not in the agency catalog/,
    );
    assert.equal(
      (
        db().prepare("SELECT count(*) count FROM plans").get() as {
          count: number;
        }
      ).count,
      before.count,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
  }
});
