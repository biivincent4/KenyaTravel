import { randomUUID } from "node:crypto";
import {
  db,
  packages,
  parsePlan,
  transaction,
  type PlanRow,
  type Booking,
  type PlanDraft,
} from "./db";
import { destinationById, transferHours } from "./catalog";
import {
  AppError,
  preferenceSchema,
  validateItinerary,
  type Preferences,
  type Draft,
  type Itinerary,
} from "./validation";

export function savePlan(
  userId: string,
  preferences: Preferences,
  draft: unknown,
  source: "ai" | "catalog",
) {
  const itinerary = validateItinerary(draft, preferences);
  const id = randomUUID();
  db()
    .prepare(
      "INSERT INTO plans(id,user_id,source,preferences,itinerary) VALUES (?,?,?,?,?)",
    )
    .run(
      id,
      userId,
      source,
      JSON.stringify(preferences),
      JSON.stringify(itinerary),
    );
  return parsePlan(
    db().prepare("SELECT * FROM plans WHERE id=?").get(id) as PlanRow,
  );
}
export function saveCatalogPlan(
  userId: string,
  packageId: string,
  input: unknown,
) {
  const { preferences, draft } = catalogDraft(packageId, input);
  return savePlan(userId, preferences, draft, "catalog");
}
export function previewCatalogPlan(packageId: string, input: unknown) {
  const { item, preferences, draft } = catalogDraft(packageId, input);
  return {
    journey: item,
    preferences,
    itinerary: validateItinerary(draft, preferences),
  };
}
function catalogDraft(packageId: string, input: unknown) {
  const preferences = preferenceSchema.parse(input);
  const item = packages().find((p) => p.id === packageId);
  if (!item) throw new AppError("That trip is not currently offered.", 404);
  if (
    item.days !==
    Math.round(
      (Date.parse(preferences.endDate) - Date.parse(preferences.startDate)) /
        86400000,
    ) +
      1
  )
    throw new AppError(
      `Choose exactly ${item.days} days for this curated trip.`,
    );
  const draft: Draft = {
    title: item.name,
    summary: item.description,
    days: item.route.map((id, index) => {
      const destination = destinationById(id)!;
      const hours = index ? transferHours(item.route[index - 1], id) : 0;
      return {
        day: index + 1,
        destinationId: id,
        activityIds:
          hours > 6
            ? []
            : [
                destination.activities[index % destination.activities.length]
                  .id,
              ],
        travelOnly: hours > 6,
      };
    }),
  };
  return { item, preferences, draft };
}
export function ownedPlan(userId: string, id: string) {
  const row = db()
    .prepare("SELECT * FROM plans WHERE id=? AND user_id=?")
    .get(id, userId) as PlanRow | undefined;
  if (!row) throw new AppError("Trip not found.", 404);
  return parsePlan(row);
}
type DraftRow = {
  id: string;
  user_id: string;
  preferences: string;
  itinerary: string;
  expires_at: number;
  saved_plan_id: string | null;
};
function draftRow(userId: string, id: string) {
  const row = db()
    .prepare("SELECT * FROM plan_drafts WHERE id=? AND user_id=?")
    .get(id, userId) as DraftRow | undefined;
  if (!row)
    throw new AppError(
      "Working itinerary not found. Create a new draft before saving.",
      404,
    );
  return row;
}
function parseDraft(row: DraftRow): PlanDraft {
  return {
    id: row.id,
    user_id: row.user_id,
    source: "ai",
    preferences: JSON.parse(row.preferences),
    itinerary: JSON.parse(row.itinerary),
    expires_at: row.expires_at,
  };
}
function requireCurrentDraft(row: DraftRow) {
  if (row.expires_at <= Date.now())
    throw new AppError(
      "This working itinerary has expired. Create a new draft before saving.",
      410,
    );
}
export function ownedDraft(userId: string, id: string) {
  const row = draftRow(userId, id);
  requireCurrentDraft(row);
  return parseDraft(row);
}
export function createPlanDraft(
  userId: string,
  preferences: Preferences,
  input: unknown,
) {
  const itinerary = validateItinerary(input, preferences);
  const id = randomUUID();
  const now = Date.now();
  db()
    .prepare(
      "DELETE FROM plan_drafts WHERE saved_plan_id IS NULL AND expires_at<=?",
    )
    .run(now);
  db()
    .prepare(
      "INSERT INTO plan_drafts(id,user_id,preferences,itinerary,expires_at) VALUES (?,?,?,?,?)",
    )
    .run(
      id,
      userId,
      JSON.stringify(preferences),
      JSON.stringify(itinerary),
      now + 86400000,
    );
  return ownedDraft(userId, id);
}
export function savePlanDraft(userId: string, id: string) {
  return transaction(() => {
    const row = draftRow(userId, id);
    if (row.saved_plan_id) return ownedPlan(userId, row.saved_plan_id);
    requireCurrentDraft(row);
    const draft = parseDraft(row);
    // Recheck feasibility, but retain the server-owned estimate snapshot shown to the customer.
    validateItinerary(
      {
        title: draft.itinerary.title,
        summary: draft.itinerary.summary,
        days: draft.itinerary.days.map(
          ({ day, destinationId, activityIds, travelOnly }) => ({
            day,
            destinationId,
            activityIds,
            travelOnly,
          }),
        ),
      },
      draft.preferences,
    );
    const planId = randomUUID();
    db()
      .prepare(
        "INSERT INTO plans(id,user_id,source,preferences,itinerary) VALUES (?,?,'ai',?,?)",
      )
      .run(planId, userId, row.preferences, row.itinerary);
    db()
      .prepare(
        "UPDATE plan_drafts SET saved_plan_id=? WHERE id=? AND user_id=?",
      )
      .run(planId, id, userId);
    return ownedPlan(userId, planId);
  });
}
export function requestBooking(userId: string, planId: string) {
  const plan = ownedPlan(userId, planId);
  preferenceSchema.parse(plan.preferences);
  const existing = db()
    .prepare("SELECT * FROM bookings WHERE user_id=? AND plan_id=?")
    .get(userId, planId) as Booking | undefined;
  if (existing) return existing;
  const id = randomUUID();
  db()
    .prepare(
      "INSERT INTO bookings(id,user_id,plan_id,status) VALUES (?,?,?,'requested')",
    )
    .run(id, userId, planId);
  return db().prepare("SELECT * FROM bookings WHERE id=?").get(id) as Booking;
}
export function ownedBooking(userId: string, id: string) {
  const booking = db()
    .prepare("SELECT * FROM bookings WHERE id=? AND user_id=?")
    .get(id, userId) as Booking | undefined;
  if (!booking) throw new AppError("Booking not found.", 404);
  return booking;
}
export function quoteValid(booking: Booking, now = new Date()) {
  return (
    !!booking.quote_amount &&
    !!booking.quote_currency &&
    !!booking.quote_expires &&
    `${booking.quote_expires}T23:59:59.999Z` > now.toISOString()
  );
}
export function issueQuote(
  id: string,
  amount: number,
  currency: string,
  notes: string,
  expiresAt: string,
) {
  if (expiresAt < new Date().toISOString().slice(0, 10))
    throw new AppError("Quote expiry must be today or later.");
  const minorAmount = Math.round(amount * 100);
  if (Math.abs(amount * 100 - minorAmount) > 0.0001)
    throw new AppError("Use at most two decimal places for the quote.");
  return transaction(() => {
    const booking = db()
      .prepare("SELECT * FROM bookings WHERE id=?")
      .get(id) as Booking | undefined;
    if (!booking) throw new AppError("Booking not found.", 404);
    if (!["requested", "quoted"].includes(booking.status))
      throw new AppError(
        "A payment-pending or paid booking cannot be re-quoted.",
        409,
      );
    const row = db()
      .prepare("SELECT itinerary,preferences FROM plans WHERE id=?")
      .get(booking.plan_id) as { itinerary: string; preferences: string };
    const preferences = JSON.parse(row.preferences) as Preferences;
    preferenceSchema.parse(preferences);
    if (expiresAt > preferences.startDate)
      throw new AppError(
        "The quote must expire no later than the trip start date.",
      );
    db()
      .prepare(
        "UPDATE bookings SET status='quoted',quote_amount=?,quote_currency=?,quote_notes=?,quote_expires=?,quote_version=quote_version+1 WHERE id=?",
      )
      .run(minorAmount, currency, notes, expiresAt, id);
    return db().prepare("SELECT * FROM bookings WHERE id=?").get(id) as Booking;
  });
}
export type TripSummary = {
  id: string;
  itinerary: Itinerary;
  preferences: Preferences;
};
