import { timingSafeEqual } from "crypto";

// Pure helpers extracted from the Quiklie notify route so they can be
// unit-tested. The route itself wires these together with DB calls.

// Quiklie status codes per API spec section 9.
export const QUIKLIE_WEBHOOK_STATUS = {
  SUCCESS: 1,
  THREE_DS_REQUIRED: 2,
  OTP_REQUIRED: 3,
  PENDING: 4,
  DECLINED: 5,
  REFUNDED: 6,
  REFUND_FAILED: 7,
  CHARGEBACK: 8,
} as const;

export const KNOWN_STATUS_CODES = new Set([1, 2, 3, 4, 5, 6, 7, 8]);

const STATUS_NAME_TO_CODE: Record<string, number> = {
  SUCCESS: 1,
  "3DS REQUIRED": 2,
  "OTP REQUIRED": 3,
  PENDING: 4,
  DECLINED: 5,
  REFUNDED: 6,
  "REFUND FAILED": 7,
  CHARGEBACK: 8,
};

/**
 * Parse Quiklie's `statusCode` field into a canonical integer. Handles
 * every shape we've seen Quiklie return:
 *   - Integer: `1`
 *   - Digit string: `"1"`
 *   - Uppercase name: `"SUCCESS"` / `"DECLINED"` (they do this sometimes)
 *   - Falls back to parsing the `status` string if statusCode is missing
 *
 * Returns null when nothing parses to a known code. Callers should treat
 * null as "don't mutate the order" — it's a Quiklie bug, not a decline.
 */
export function parseQuiklieStatusCode(
  rawStatusCode: unknown,
  fallbackStatus: string = "",
): number | null {
  let code: number | null = null;

  if (typeof rawStatusCode === "number" && Number.isInteger(rawStatusCode)) {
    code = rawStatusCode;
  } else if (typeof rawStatusCode === "string") {
    if (/^\d+$/.test(rawStatusCode)) {
      code = parseInt(rawStatusCode, 10);
    } else {
      code = STATUS_NAME_TO_CODE[rawStatusCode.toUpperCase()] ?? null;
    }
  }

  if (code === null || !KNOWN_STATUS_CODES.has(code)) {
    // Fall back to parsing the `status` string when statusCode is absent
    // or malformed, so we don't silently drop otherwise-valid callbacks.
    const fallbackCode = STATUS_NAME_TO_CODE[fallbackStatus.toUpperCase()];
    if (typeof fallbackCode === "number") return fallbackCode;
    return null;
  }

  return code;
}

/**
 * Constant-time string equality. `timingSafeEqual` throws on length
 * mismatch, so we pad both sides to the max length to avoid the
 * length-side-channel that an early return would create.
 */
export function safeEqual(a: string, b: string): boolean {
  const la = Buffer.byteLength(a);
  const lb = Buffer.byteLength(b);
  const len = Math.max(la, lb, 1);
  const ba = Buffer.alloc(len);
  const bb = Buffer.alloc(len);
  ba.write(a);
  bb.write(b);
  const eq = timingSafeEqual(ba, bb);
  return eq && la === lb;
}

/**
 * Checks whether the webhook's declared `amount` (dollars) matches our
 * stored order total (cents). Tolerance of 1¢ for float-side rounding.
 * Returns `false` on NaN / non-finite amounts so malformed callbacks
 * don't flip an order to paid.
 */
export function amountMatches(
  webhookAmountDollars: number,
  orderTotalCents: number,
): boolean {
  if (!Number.isFinite(webhookAmountDollars)) return false;
  const expectedDollars = orderTotalCents / 100;
  return Math.abs(webhookAmountDollars - expectedDollars) <= 0.01;
}
