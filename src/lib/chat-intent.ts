export function isSaveItineraryRequest(message: string) {
  const text = message
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ");
  return /^(?:(?:please|can you|could you|would you) )?save(?: (?:(?:(?:my|this|the|current) )?(?:itinerary|itinery|plan|trip)|it|this))?(?: (?:to|in) my trips)?(?: please)?$/.test(
    text,
  );
}
