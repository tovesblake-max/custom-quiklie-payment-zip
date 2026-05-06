/**
 * custom-quiklie-payment-zip — production-tested Quiklie payment integration for
 * Next.js (App Router).
 *
 * Public API surface:
 *
 *   import {
 *     // Core API client
 *     processPaymentHPP,
 *     processPaymentS2S,
 *     processRefund,
 *     verifyOTP,
 *     getTransactionStatus,
 *     generateQuiklieRef,
 *
 *     // Status code constants
 *     QUIKLIE_STATUS,
 *
 *     // Webhook validation helpers
 *     parseQuiklieStatusCode,
 *     amountMatches,
 *     safeEqual,
 *     QUIKLIE_WEBHOOK_STATUS,
 *
 *     // Address normalization
 *     normalizeUSStateCode,
 *
 *     // Customer-friendly decline message translation
 *     translateQuiklieDecline,
 *   } from "custom-quiklie-payment-zip";
 *
 * Webhook + checkout route handlers ship as templates under
 * `examples/` — copy them into `app/api/...` and tune for your stack.
 */

export {
  processPaymentHPP,
  processPaymentS2S,
  processRefund,
  verifyOTP,
  getTransactionStatus,
  generateQuiklieRef,
  QUIKLIE_STATUS,
  type QuiklieStatusCode,
  type QuiklieBilling,
  type QuiklieProcessResponse,
  type QuiklieHPPParams,
  type QuiklieS2SParams,
  type QuiklieRefundResponse,
} from "./lib/quiklie";

export {
  parseQuiklieStatusCode,
  amountMatches,
  safeEqual,
  QUIKLIE_WEBHOOK_STATUS,
  KNOWN_STATUS_CODES,
} from "./lib/quiklie-webhook";

export { normalizeUSStateCode } from "./lib/us-states";

export {
  translateQuiklieDecline,
  type DeclineExplanation,
} from "./lib/quiklie-decline-messages";
