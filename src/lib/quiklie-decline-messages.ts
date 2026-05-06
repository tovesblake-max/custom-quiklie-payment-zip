/**
 * Customer-friendly translations for Quiklie decline / failure messages.
 *
 * Quiklie's raw decline strings are gateway-internal jargon ("Deny by
 * red shield", "Transaction declined by authorisation system") that
 * tell the customer nothing actionable. The Quiklie engineering team
 * shared the meaning of each well-known message; this map turns them
 * into one-sentence-each English explanations the customer can act on
 * without contacting support.
 *
 * Anything we don't recognise falls through to a generic message —
 * the raw Quiklie string is logged server-side via the notify webhook
 * for debugging but is NOT shown to the customer (it would just
 * confuse them).
 *
 * Pure function, no side effects, safe to call from both server and
 * client components.
 */

export interface DeclineExplanation {
  /** Short, action-oriented headline shown above the explanation. */
  headline: string;
  /** One or two sentences explaining what to do next. */
  detail: string;
  /** Optional CTA hint (e.g. "Try a different card"). */
  cta?: string;
}

// Match against the lower-cased Quiklie string. Patterns are checked in
// order — the first hit wins. Keep specific-before-generic.
const PATTERNS: Array<{ test: RegExp; result: DeclineExplanation }> = [
  // International transactions disabled — by far the most common
  // decline cause per Quiklie's dev team. The DTF HORIZONTRV acquirer
  // routes internationally; many US issuers block international
  // charges by default and require the customer to opt in via app /
  // phone call.
  {
    test: /declined by authoris(ation|ation) system|international transaction|cross[- ]?border|foreign transaction/i,
    result: {
      headline: "Your bank blocked an international transaction",
      detail:
        "Our payment processor routes through an international acquirer, and your card issuer rejected the charge because international purchases are disabled on your card. Open your banking app or call the number on the back of your card and enable international transactions, then try paying again.",
      cta: "Enable international payments and retry",
    },
  },

  // Card brand not supported — the gateway hard-blocks card networks
  // it doesn't have an acquirer relationship for. We don't surface the
  // specific brand by name (Blake's preference: don't advertise what
  // we can't process). Customer just needs a different card.
  {
    test: /red shield|card brand not supported|unsupported card brand|brand not allowed/i,
    result: {
      headline: "That card type isn't accepted",
      detail:
        "We accept Visa, Mastercard, and American Express. Please retry with one of those.",
      cta: "Use Visa, Mastercard, or AMEX",
    },
  },

  // Insufficient funds — not really our problem to solve, but a
  // clearer message lets the customer act without guessing.
  {
    test: /insufficient funds|do not honor|do not honour|nsf|not sufficient/i,
    result: {
      headline: "Your card was declined for insufficient funds",
      detail:
        "Your bank rejected the charge. Try again with a different card or after funds clear.",
      cta: "Try a different card",
    },
  },

  // Expired card / invalid card data — formatting issues.
  {
    test: /expired card|card expired|invalid expir/i,
    result: {
      headline: "Your card has expired",
      detail:
        "The expiry date on the card you used has passed. Try again with a current card.",
      cta: "Use a different card",
    },
  },
  {
    test: /invalid card|invalid cvv|invalid cvc|wrong cvv|incorrect cvv/i,
    result: {
      headline: "The card details didn't match",
      detail:
        "Your card number, expiry date, or CVV didn't match what your bank has on file. Double-check and try again.",
      cta: "Re-enter your card",
    },
  },

  // 3DS / OTP failure — customer didn't complete the bank challenge.
  {
    test: /3ds (failed|abandoned)|three[- ]?ds (failed|abandoned)|authentication (failed|abandoned)|otp (failed|expired)/i,
    result: {
      headline: "Bank verification was not completed",
      detail:
        "Your bank required a one-time code or 3D Secure verification, and the step wasn't finished. Retry and complete the verification when prompted.",
      cta: "Try again and complete verification",
    },
  },

  // Generic do-not-honor / hard decline — bank refused for an
  // undisclosed reason. Customer needs to contact bank or use a
  // different card.
  {
    test: /declined|refused|rejected|decline/i,
    result: {
      headline: "Your card was declined",
      detail:
        "Your bank refused the charge but didn't share a reason. Common causes: international transactions disabled, fraud-block on the card, or a low limit. Contact your bank or try a different card.",
      cta: "Try a different card",
    },
  },
];

const FALLBACK: DeclineExplanation = {
  headline: "Payment could not be completed",
  detail:
    "Your card was not charged. This usually clears up on retry; if it keeps happening, please email support@stillwaterbiolabs.com with your order number.",
  cta: "Try again or contact support",
};

/**
 * Translate a raw Quiklie failure message into a customer-friendly
 * explanation. Returns the FALLBACK message when nothing matches.
 *
 * @param rawMessage The `quikleeMessage` / `message` field from a
 *                   Quiklie callback or status-poll response. May be
 *                   null / empty.
 */
export function translateQuiklieDecline(rawMessage: string | null | undefined): DeclineExplanation {
  if (!rawMessage || typeof rawMessage !== "string") return FALLBACK;
  const trimmed = rawMessage.trim();
  if (trimmed.length === 0) return FALLBACK;
  for (const p of PATTERNS) {
    if (p.test.test(trimmed)) return p.result;
  }
  return FALLBACK;
}
