import Stripe from "stripe";
import { db, transaction, type Booking } from "./db";
import { AppError, preferenceSchema } from "./validation";
import { ownedBooking, ownedPlan, quoteValid } from "./travel";

export const paymentReady = () =>
  !!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") &&
  !!process.env.STRIPE_WEBHOOK_SECRET &&
  !!process.env.APP_URL;
function stripe() {
  if (!paymentReady())
    throw new AppError(
      "Test checkout is not configured. The agency must set a Stripe test key, webhook secret and APP_URL. Your request is saved; no payment has been taken.",
      503,
    );
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    httpClient: Stripe.createFetchHttpClient(),
    timeout: 20000,
    maxNetworkRetries: 1,
  });
}
export async function createCheckout(userId: string, id: string) {
  const provider = stripe();
  const booking = transaction(() => {
    const b = ownedBooking(userId, id);
    if (!["quoted", "payment_pending"].includes(b.status))
      throw new AppError("Only an agency-issued quote can be paid.", 409);
    const plan = ownedPlan(userId, b.plan_id);
    preferenceSchema.parse(plan.preferences);
    if (!quoteValid(b))
      throw new AppError(
        "This quote has expired. Contact the agency for a refreshed quote.",
        409,
      );
    if (
      Date.parse(`${b.quote_expires}T23:59:59.999Z`) - Date.now() <
      31 * 60000
    )
      throw new AppError(
        "This quote expires too soon to start checkout. Contact the agency for a refreshed quote.",
        409,
      );
    if (b.status === "quoted")
      db()
        .prepare(
          "UPDATE bookings SET status='payment_pending' WHERE id=? AND status='quoted'",
        )
        .run(id);
    return b;
  });
  if (booking.checkout_url) return booking.checkout_url;
  const base = process.env.APP_URL!.replace(/\/$/, "");
  // Keep the reservation on network failure: retrying uses the same provider idempotency key.
  const session = await provider.checkout.sessions.create(
    {
      mode: "payment",
      client_reference_id: booking.id,
      expires_at: Math.floor(
        Math.min(
          Date.now() + 24 * 3600000 - 10000,
          Date.parse(`${booking.quote_expires}T23:59:59.999Z`),
        ) / 1000,
      ),
      metadata: {
        bookingId: booking.id,
        quoteVersion: String(booking.quote_version),
      },
      line_items: [
        {
          price_data: {
            currency: booking.quote_currency!.toLowerCase(),
            unit_amount: booking.quote_amount!,
            product_data: {
              name: "Sanaa Kenya - agency-confirmed travel quote",
              description:
                "TEST MODE ONLY. No live charges. View inclusions and exclusions in your saved quote.",
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${base}/?checkout=returned#trips`,
      cancel_url: `${base}/?checkout=cancelled#trips`,
    },
    { idempotencyKey: `booking-${booking.id}-quote-${booking.quote_version}` },
  );
  if (!session.url || session.livemode)
    throw new AppError(
      "The payment provider did not return a valid test checkout. Contact the agency.",
      502,
    );
  db()
    .prepare(
      "UPDATE bookings SET checkout_session=?,checkout_url=? WHERE id=? AND status='payment_pending' AND quote_version=?",
    )
    .run(session.id, session.url, id, booking.quote_version);
  return session.url;
}
export type PaymentEvent = {
  id: string;
  type: string;
  livemode: boolean;
  data: { object: unknown };
};
export function applyPaymentEvent(event: PaymentEvent) {
  if (event.livemode)
    throw new AppError("Live payment events are disabled in this MVP.", 400);
  return transaction(() => {
    if (db().prepare("SELECT id FROM webhook_events WHERE id=?").get(event.id))
      return { duplicate: true };
    if (
      [
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.expired",
        "checkout.session.async_payment_failed",
      ].includes(event.type)
    ) {
      const session = event.data.object as Stripe.Checkout.Session;
      const id = session.metadata?.bookingId;
      const b = id
        ? (db().prepare("SELECT * FROM bookings WHERE id=?").get(id) as
            Booking | undefined)
        : undefined;
      if (
        !b ||
        b.checkout_session !== session.id ||
        String(b.quote_version) !== session.metadata?.quoteVersion
      )
        throw new AppError(
          "Webhook does not match an active booking checkout.",
          409,
        );
      if (
        session.amount_total !== b.quote_amount ||
        session.currency?.toUpperCase() !== b.quote_currency
      )
        throw new AppError(
          "Webhook amount or currency does not match the agency quote.",
          409,
        );
      if (
        [
          "checkout.session.completed",
          "checkout.session.async_payment_succeeded",
        ].includes(event.type) &&
        session.payment_status === "paid"
      ) {
        if (!["payment_pending", "paid"].includes(b.status))
          throw new AppError(
            "Booking cannot accept this payment transition.",
            409,
          );
        const intent =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id;
        if (!intent)
          throw new AppError(
            "Paid event is missing its payment reference.",
            409,
          );
        db()
          .prepare(
            "UPDATE bookings SET status='paid',payment_intent=? WHERE id=?",
          )
          .run(intent, b.id);
      }
      if (
        [
          "checkout.session.expired",
          "checkout.session.async_payment_failed",
        ].includes(event.type) &&
        b.status === "payment_pending"
      ) {
        db()
          .prepare(
            "UPDATE bookings SET status='quoted',checkout_session=NULL,checkout_url=NULL,quote_version=quote_version+1 WHERE id=?",
          )
          .run(b.id);
      }
    }
    db().prepare("INSERT INTO webhook_events(id) VALUES (?)").run(event.id);
    return { duplicate: false };
  });
}
export function verifyWebhook(body: string, signature: string) {
  const provider = stripe();
  try {
    return provider.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch {
    throw new AppError("Invalid Stripe webhook signature.", 400);
  }
}
