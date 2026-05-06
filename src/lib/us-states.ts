/**
 * US state name → 2-letter USPS code normalizer.
 *
 * Used by every payment rail that ships customer addresses to a third
 * party (Quiklie HPP via lib/quiklie.ts, KingsGate via /api/cs/order-
 * detail). Both gateways are happiest with 2-letter codes:
 *   - Quiklie: hard-rejects anything > 5 chars with `state must be
 *     1-5 characters`. We've seen real customers fail submission
 *     because their saved address had "California" in the state field.
 *   - KingsGate / PayPal: accepts both forms but AVS only matches when
 *     the 2-letter code is sent. A full-name state can pass auth but
 *     fail AVS on the back-end, leading to higher chargebacks.
 *
 * The checkout form input enforces 2 chars at type-time, but we have
 * to defend against:
 *   - Pre-existing addresses in the DB stored as full state names
 *     (legacy from before the input enforcement landed)
 *   - Saved-address rehydration from older code paths
 *   - External tools / API consumers that POST orders directly
 *
 * Pure function, no I/O. Safe to call from both server and client.
 */

const NAME_TO_CODE: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR",
  CALIFORNIA: "CA", COLORADO: "CO", CONNECTICUT: "CT", DELAWARE: "DE",
  FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID",
  ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA", KANSAS: "KS",
  KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD",
  MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN", MISSISSIPPI: "MS",
  MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV",
  "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY",
  "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK",
  OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC",
  "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT",
  VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV",
  WISCONSIN: "WI", WYOMING: "WY", "DISTRICT OF COLUMBIA": "DC",
  "PUERTO RICO": "PR", "VIRGIN ISLANDS": "VI", "U.S. VIRGIN ISLANDS": "VI",
  "US VIRGIN ISLANDS": "VI", GUAM: "GU", "AMERICAN SAMOA": "AS",
  "NORTHERN MARIANA ISLANDS": "MP",
};

const VALID_CODES = new Set(Object.values(NAME_TO_CODE));

/**
 * Normalize a state value to its 2-letter USPS code where possible.
 * Falls back to the first 5 chars uppercased so the call site can still
 * pass *something* to a strict gateway (Quiklie's 5-char hard limit) —
 * a malformed value beats a 400 from the processor.
 *
 * @param state Raw state input (any case, may include punctuation).
 * @returns 2-letter code when recognized, "XX" placeholder when empty,
 *          first-5-chars uppercase otherwise.
 */
export function normalizeUSStateCode(state: string | null | undefined): string {
  const trimmed = (state || "").trim().toUpperCase();
  if (trimmed.length === 0) return "XX";
  if (trimmed.length <= 2 && VALID_CODES.has(trimmed)) return trimmed;
  // Strip punctuation + collapse whitespace so "N.Y." or "New  York"
  // hit the lookup table cleanly.
  const cleaned = trimmed.replace(/\./g, "").replace(/\s+/g, " ");
  if (NAME_TO_CODE[cleaned]) return NAME_TO_CODE[cleaned];
  return trimmed.slice(0, 5);
}
