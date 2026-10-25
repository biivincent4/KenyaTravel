import { z } from "zod";
import { destinationById, interests, transferHours } from "./catalog";

export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const time = Date.parse(`${v}T00:00:00Z`);
    return (
      Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === v
    );
  }, "Enter a valid calendar date.");
export const preferenceSchema = z
  .object({
    startDate: date,
    endDate: date,
    partySize: z.number().int().min(1).max(12),
    budget: z.number().min(100).max(1000000),
    currency: z.enum(["USD", "KES"]),
    interests: z
      .array(z.enum(interests as [string, ...string[]]))
      .min(1)
      .max(8),
  })
  .strict()
  .superRefine((value, ctx) => {
    const days = duration(value.startDate, value.endDate);
    if (days < 2 || days > 14)
      ctx.addIssue({
        code: "custom",
        message:
          "Trips must last 2 to 14 days, including arrival and departure days.",
      });
    if (value.startDate < new Date().toISOString().slice(0, 10))
      ctx.addIssue({
        code: "custom",
        message: "Choose a start date today or later.",
      });
  });
export type Preferences = z.infer<typeof preferenceSchema>;
export function duration(start: string, end: string) {
  return (
    Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
        86400000,
    ) + 1
  );
}
export function dateForDay(start: string, index: number) {
  return new Date(Date.parse(`${start}T00:00:00Z`) + index * 86400000)
    .toISOString()
    .slice(0, 10);
}
export const draftSchema = z
  .object({
    title: z.string().min(3).max(100),
    summary: z.string().min(10).max(1200),
    days: z
      .array(
        z
          .object({
            day: z.number().int().min(1).max(14),
            destinationId: z.string().max(30),
            activityIds: z.array(z.string().max(60)).max(3),
            travelOnly: z.boolean(),
          })
          .strict(),
      )
      .min(2)
      .max(14),
  })
  .strict();
export type Draft = z.infer<typeof draftSchema>;
export type Itinerary = Omit<Draft, "days"> & {
  days: (Draft["days"][number] & {
    date: string;
    destinationName: string;
    activities: string[];
    transferHours: number;
  })[];
  estimate: {
    amount: number;
    currency: "USD" | "KES";
    withinBudget: boolean;
    rateNote: string;
  };
};

export function validateItinerary(
  input: unknown,
  preferences: Preferences,
): Itinerary {
  const p = preferenceSchema.parse(preferences);
  const draft = draftSchema.parse(input);
  if (draft.days.length !== duration(p.startDate, p.endDate))
    throw new AppError("The itinerary does not match your travel dates.");
  const days = draft.days.map((day, index) => {
    const destination = destinationById(day.destinationId);
    if (!destination || day.day !== index + 1)
      throw new AppError(
        "The itinerary contains an unknown destination or out-of-order day.",
      );
    if (new Set(day.activityIds).size !== day.activityIds.length)
      throw new AppError("An activity is repeated within a day.");
    const activities = day.activityIds.map((id) => {
      const activity = destination.activities.find((a) => a.id === id);
      if (!activity)
        throw new AppError(
          "An itinerary activity is not in the agency catalog.",
        );
      return activity.name;
    });
    const hours = index
      ? transferHours(draft.days[index - 1].destinationId, day.destinationId)
      : 0;
    if (hours > 10)
      throw new AppError(
        "This road transfer is too long for one day. Choose a closer destination or a separate trip.",
      );
    if ((hours > 6 && !day.travelOnly) || (hours >= 5 && activities.length > 1))
      throw new AppError(
        "This itinerary leaves too little time for its road transfer.",
      );
    if (
      (day.travelOnly && activities.length) ||
      (!day.travelOnly && !activities.length)
    )
      throw new AppError(
        "Travel days must have no activities; other days need at least one catalog activity.",
      );
    return {
      ...day,
      date: dateForDay(p.startDate, index),
      destinationName: destination.name,
      activities,
      transferHours: hours,
    };
  });
  const usd =
    days.reduce(
      (sum, day) => sum + destinationById(day.destinationId)!.dailyUsd,
      0,
    ) * p.partySize;
  const amount = Math.round(usd * (p.currency === "KES" ? 130 : 1));
  return {
    ...draft,
    days,
    estimate: {
      amount,
      currency: p.currency,
      withinBudget: amount <= p.budget,
      rateNote:
        "Illustrative catalog estimate, not availability or a quote. Sample conversion: USD 1 = KES 130; not a live exchange rate. International flights, visas, insurance and unlisted transfers excluded.",
    },
  };
}

export const credentialSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase().trim()),
  password: z.string().min(12).max(128),
});
export const quoteSchema = z.object({
  bookingId: z.string().uuid(),
  amount: z.number().min(1).max(1000000),
  currency: z.enum(["USD", "KES"]),
  notes: z.string().min(10).max(2000),
  expiresAt: date,
});
export function money(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}
