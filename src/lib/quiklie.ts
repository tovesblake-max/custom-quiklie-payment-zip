// Quiklie S2S + HPP Payment API client.
//
// Two flavors:
//   - HPP (`/api/v2/process-payment/hpp`) — Quiklie hosts the card entry
//     page and returns a redirect URL. Keeps us at PCI SAQ-A (no card PAN
//     ever touches our servers). THIS IS THE CUSTOMER-FACING CHECKOUT
//     PATH — wired through src/app/api/checkout/quiklie-hpp/route.ts and
//     gated by NEXT_PUBLIC_QUIKLIE_HPP_ENABLED (default ON).
//   - S2S (`/api/v2/process-payment`) — we POST the full card PAN +
//     expiry + CVV. Triggers SAQ-D compliance scope. Retained ONLY for
//     admin/refund tooling and as an emergency rollback target if HPP
//     misbehaves. Must NEVER be the customer-facing path in production
//     without an accompanying QSA review of cardholder-data scope.
//
// Both paths may return statusCode 2 (3DS required — redirect customer to
// `quikleeRedirectUrl`) or 3 (OTP required — collect OTP, call verify).
//
// Required env vars:
//   QUIKLIE_API_KEY         — merchant API key (from dashboard → profile)
//   QUIKLIE_MERCHANT_ID     — merchant / user ID (same dashboard location)
//   QUIKLIE_WEBHOOK_API_KEY — API key the webhook arrives with (usually
//                             the same as QUIKLIE_API_KEY — confirm with
//                             Quiklie at onboarding)
//
// Docs: https://api.quiklie.com (see Quiklie_API_Documentation PDF)

import { normalizeUSStateCode } from "./us-states";

const QUIKLIE_BASE = "https://api.quiklie.com";

// ── Status code catalog ────────────────────────────────────
// Lifted from the Quiklie V2 API spec, section 9.
export const QUIKLIE_STATUS = {
  SUCCESS: 1,
  THREE_DS_REQUIRED: 2,
  OTP_REQUIRED: 3,
  PENDING: 4,
  DECLINED: 5,
  REFUNDED: 6,
  REFUND_FAILED: 7,
  CHARGEBACK: 8,
} as const;

export type QuiklieStatusCode = (typeof QUIKLIE_STATUS)[keyof typeof QUIKLIE_STATUS];

// ── Shared types ──────────────────────────────────────────

export interface QuiklieBilling {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  address: string;
  zipCode: string;
  city: string;
  state: string;
  country: string; // ISO-2 (e.g. "US")
}

export interface QuiklieProcessResponse {
  status: string;
  statusCode: string; // Quiklie returns this as a string but it's numeric per spec
  qkpaymentId: string;
  amount?: number;
  currency?: string;
  last4digit?: string;
  message?: string;
  quikleeRedirectUrl?: string; // 3DS redirect if statusCode = 2
  customerReferenceId?: string;
  transactionReferenceId?: string;
}

export interface QuiklieHPPParams {
  amountDollars: number;
  billing: QuiklieBilling;
  callbackUrl: string;
  redirectUrl: string;
  ipAddress?: string;
  customerReferenceId?: string;
  transactionReferenceId?: string;
  midType?: "THREE_D" | "TWO_D";
  descriptor?: string;
}

export interface QuiklieS2SParams extends QuiklieHPPParams {
  card: {
    number: string; // digits only
    holderName: string;
    expiryMonth: string; // "MM"
    expiryYear: string; // "YYYY"
    cvv: string;
  };
}

// ── Internal helpers ──────────────────────────────────────

function getCreds() {
  const apiKey = process.env.QUIKLIE_API_KEY;
  const merchantId = process.env.QUIKLIE_MERCHANT_ID;
  if (!apiKey || !merchantId) {
    throw new Error(
      "Quiklie is not configured. Set QUIKLIE_API_KEY and QUIKLIE_MERCHANT_ID.",
    );
  }
  return { apiKey, merchantId };
}

function headers(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    // Spec requires "api" or "plugin". We're integrating S2S/HPP as a
    // native code integration so "api" is the correct value.
    "x-source": "api",
  };
}

/**
 * Keep amount as a number with 2 decimal precision. Quiklie's examples
 * pass bare numbers like `15` but we always want `15.00` serialisation
 * so their parser doesn't misread integer vs float.
 */
function roundAmount(dollars: number): number {
  return Math.round(dollars * 100) / 100;
}

/**
 * Quiklie requires phone as 10-15 digits, no `+`, no formatting.
 * Our DB stores phones in E.164 (`+14058801465`); strip non-digits
 * before submitting so the leading `+` doesn't blow the validator.
 * Empty / unparseable input falls back to a placeholder so the
 * request still gets accepted (Quiklie rejects with 400 when the
 * field is empty entirely).
 */
function normalizePhoneForQuiklie(phone: string | undefined): string {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length >= 10 && digits.length <= 15) return digits;
  // Too short / too long → use a 10-digit placeholder that satisfies
  // Quiklie's regex without leaking a real number from another user.
  return "0000000000";
}

// State-name → USPS-code normalization lives in lib/us-states.ts so
// both the Quiklie HPP path and the CardsShield/KingsGate path share
// the same defensive logic. Re-exported as a local alias to keep the
// call sites below readable.
const normalizeStateForQuiklie = normalizeUSStateCode;

async function quiklieRequest<T>(
  path: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: T | null; raw: string }> {
  const { apiKey } = getCreds();
  const url = `${QUIKLIE_BASE}${path}`;

  const res = await fetch(url, {
    method,
    headers: headers(apiKey),
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await res.text();
  let data: T | null = null;
  try {
    data = raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // leave data null; caller handles raw
  }

  if (!res.ok) {
    console.warn("[quiklie] non-2xx response", {
      path,
      method,
      http_status: res.status,
      raw: raw.slice(0, 1500),
    });
  }

  return { ok: res.ok, status: res.status, data, raw };
}

// ── Public API ────────────────────────────────────────────

/**
 * Initiate a hosted-payment-page transaction. Quiklie responds with a
 * redirect URL we send the customer to; they fill in card details on
 * Quiklie's domain and we receive the final result via callback webhook.
 *
 * Preferred path over S2S — keeps card PAN off our infrastructure and
 * maintains PCI SAQ-A scope (same posture as the current CardsShield
 * iframe integration).
 */
export async function processPaymentHPP(params: QuiklieHPPParams) {
  const { merchantId } = getCreds();
  // Quiklie rejects the request with 400 if phone or ipAddress are
  // missing entirely — despite the docs showing them as optional-looking
  // fields. Fall back to safe placeholders when the caller doesn't have
  // real values (guest checkouts, server-to-server contexts without
  // ipAddress in request headers, etc.).
  const body: Record<string, unknown> = {
    merchantId,
    firstName: params.billing.firstName,
    lastName: params.billing.lastName,
    email: params.billing.email,
    phone: normalizePhoneForQuiklie(params.billing.phone),
    amount: roundAmount(params.amountDollars),
    currencyCode: "USD",
    address: params.billing.address,
    zipCode: params.billing.zipCode,
    city: params.billing.city,
    state: normalizeStateForQuiklie(params.billing.state),
    country: params.billing.country,
    ipAddress: params.ipAddress || "0.0.0.0",
    callbackUrl: params.callbackUrl,
    redirectUrl: params.redirectUrl,
  };
  if (params.customerReferenceId) body.customerReferenceId = params.customerReferenceId;
  if (params.transactionReferenceId) body.transactionReferenceId = params.transactionReferenceId;
  if (params.midType) body.midType = params.midType;
  if (params.descriptor) body.descriptor = params.descriptor;

  const res = await quiklieRequest<QuiklieProcessResponse>(
    "/api/v2/process-payment/hpp",
    "POST",
    body,
  );
  return res;
}

/**
 * Initiate a server-to-server transaction. We POST the card PAN + CVV.
 * Triggers SAQ-D PCI scope if ever used in production. Kept here for
 * completeness + admin refunds that may need direct S2S. DO NOT use as
 * the customer-facing checkout path without a PCI review.
 */
export async function processPaymentS2S(params: QuiklieS2SParams) {
  const { merchantId } = getCreds();
  const body: Record<string, unknown> = {
    merchantId,
    firstName: params.billing.firstName,
    lastName: params.billing.lastName,
    email: params.billing.email,
    phone: normalizePhoneForQuiklie(params.billing.phone),
    amount: roundAmount(params.amountDollars),
    currencyCode: "USD",
    address: params.billing.address,
    zipCode: params.billing.zipCode,
    city: params.billing.city,
    state: normalizeStateForQuiklie(params.billing.state),
    country: params.billing.country,
    ipAddress: params.ipAddress || "0.0.0.0",
    callbackUrl: params.callbackUrl,
    redirectUrl: params.redirectUrl,
    cardNumber: params.card.number.replace(/\D/g, ""),
    cardHolderName: params.card.holderName,
    cardExpiryMonth: params.card.expiryMonth,
    cardExpiryYear: params.card.expiryYear,
    cardCvv: params.card.cvv,
  };
  if (params.customerReferenceId) body.customerReferenceId = params.customerReferenceId;
  if (params.transactionReferenceId) body.transactionReferenceId = params.transactionReferenceId;
  if (params.midType) body.midType = params.midType;
  if (params.descriptor) body.descriptor = params.descriptor;

  const res = await quiklieRequest<QuiklieProcessResponse>(
    "/api/v2/process-payment",
    "POST",
    body,
  );
  return res;
}

/**
 * Submit an OTP code for a transaction that returned statusCode = 3.
 */
export async function verifyOTP(transactionId: string, otp: string) {
  return quiklieRequest<{
    approved: boolean;
    status: string;
    message: string;
    transactionId: string;
  }>("/api/v1/verify-otp", "POST", { transactionId, otp });
}

/**
 * Issue a refund against a Quiklie transaction.
 *
 * Endpoint: `POST /api/v1/refund` (per Quiklie V2 spec § refund).
 *
 * Quiklie returns the standard `status` / `statusCode` envelope. A
 * successful submission lands at code 6 (REFUNDED). Code 7
 * (REFUND_FAILED) means the gateway accepted the request but the
 * issuer rejected — the caller must surface that as a refund failure.
 *
 * Notes:
 *   - `transactionId` is the Quiklie payment id we stored on the
 *     order at checkout time (`orders.quikliePaymentId`).
 *   - `amountDollars` supports partials. Quiklie validates that the
 *     cumulative refunded amount across all calls cannot exceed the
 *     original capture; we mirror that check on our side too.
 *   - `currencyCode` defaults to USD — that's the only currency we
 *     ever charge in. Threading it as an arg keeps the function
 *     general for parity with the WP gateway plugin.
 *   - `reason` is optional, capped at 500 chars by Quiklie. We don't
 *     trim here — the caller (admin route) already enforces 200.
 *
 * Was previously a no-op in the WordPress reference plugin (v2.1.0
 * fixed it). Our admin refund route was already gated behind the
 * CardsShield `csTradeNo` field so Quiklie orders couldn't refund at
 * all; this function is what un-blocks them.
 */
export interface QuiklieRefundResponse {
  status: string;
  statusCode: string;
  message?: string;
  transactionId?: string;
  qkpaymentId?: string;
  refundId?: string;
  amount?: number;
  currency?: string;
}

export async function processRefund(params: {
  transactionId: string;
  amountDollars: number;
  currencyCode?: string;
  reason?: string;
}) {
  const body: Record<string, unknown> = {
    transactionId: params.transactionId,
    amount: roundAmount(params.amountDollars),
    currencyCode: (params.currencyCode || "USD").toUpperCase(),
  };
  if (params.reason && params.reason.trim().length > 0) {
    body.reason = params.reason.trim();
  }
  return quiklieRequest<QuiklieRefundResponse>(
    "/api/v1/refund",
    "POST",
    body,
  );
}

/**
 * Poll a transaction's current status. Use sparingly — the callback
 * webhook is the primary source of truth. This is a fallback for cases
 * where the callback never arrives (rare).
 */
export async function getTransactionStatus(paymentOrReferenceId: string) {
  const encoded = encodeURIComponent(paymentOrReferenceId);
  return quiklieRequest<{
    quickleePaymentId: string;
    status: string;
    statusCode: string;
    quikleeMessage?: string;
    amount?: number;
    currency?: string;
    customerReferenceId?: string;
    transactionReferenceId?: string;
  }>(`/api/v1/transaction-status/${encoded}`, "GET");
}

/**
 * Generate a per-order transaction reference. Per Quiklie spec: min 10
 * chars, unique per transaction. We use a prefix + timestamp + random
 * suffix so it's easy to correlate with our order numbers.
 */
export function generateQuiklieRef(orderNumber: string): string {
  const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
  const ts = Date.now().toString(36).toUpperCase();
  return `${orderNumber.replace(/[^A-Z0-9]/gi, "")}-${ts}-${rand}`;
}
