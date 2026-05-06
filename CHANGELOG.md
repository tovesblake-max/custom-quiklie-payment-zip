# Changelog

## 1.0.0 — 2026-05-06

Initial public release. Extracted from the Stillwater BioLabs production Next.js + Drizzle stack after 6 months of live merchant traffic.

### Included

- **Core API client** (`lib/quiklie.ts`)
  - `processPaymentHPP()` — hosted-payment-page checkout (PCI SAQ-A)
  - `processPaymentS2S()` — server-to-server (PCI SAQ-D, admin tooling only)
  - `processRefund()` — full + partial refunds via `/api/v1/refund`
  - `verifyOTP()` — OTP verification for status code 3 transactions
  - `getTransactionStatus()` — poll fallback for missed webhooks
  - `generateQuiklieRef()` — collision-safe transaction reference generator
  - Phone normalizer (E.164 → 10-15 digit Quiklie format)
  - State normalizer (full names → 2-letter USPS codes)

- **Webhook helpers** (`lib/quiklie-webhook.ts`)
  - `parseQuiklieStatusCode()` — handles integer / digit-string / uppercase-name shapes
  - `amountMatches()` — defense against forged-SUCCESS attacks
  - `safeEqual()` — constant-time API key comparison
  - `QUIKLIE_WEBHOOK_STATUS` constants

- **Decline message translation** (`lib/quiklie-decline-messages.ts`)
  - `translateQuiklieDecline()` — maps gateway jargon to customer-friendly English
  - Patterns for: international-transaction blocks, unsupported card brands, insufficient funds, expired cards, invalid CVV, 3DS/OTP abandonment, generic declines

- **State normalizer** (`lib/us-states.ts`)
  - `normalizeUSStateCode()` — handles full state names, punctuation, whitespace
  - 50 states + DC + PR/VI/GU/AS/MP territories

- **Route templates** (`examples/api/`)
  - HPP checkout endpoint with idempotency-key flow + minimum-amount guard + no-phantom-order pattern
  - Webhook receiver with auth + amount-match + atomic completion claim
  - Result poll endpoint with race-safe fallback to Quiklie's status API
  - OTP verification endpoint
  - Admin refund endpoint with atomic claim + cumulative tracking + audit notes

- **React components** (`examples/components/`)
  - `<PayWithCardButton>` — single-click HPP redirect with idempotency-key reuse on double-click
  - `<QuiklieRedirectNotice>` — pre-pay heads-up about descriptor + international cards
  - `<CheckoutCallback>` — race-safe polling page that prevents the duplicate-order bug

- **Documentation**
  - README with quick-start (15 min) + comparison vs WooCommerce plugin
  - INSTALLATION.md — step-by-step
  - WEBHOOK_SETUP.md — setup + troubleshooting
  - TROUBLESHOOTING.md — every production issue we hit and how we fixed it

### Production-tested fixes baked in

This release incorporates every bug + fix from 6 months of running Quiklie in production:

1. **Race-safe completion claim** — atomic conditional UPDATE prevents double-firing of fulfillment / email / analytics when webhook + result-poll + reconcile-cron land concurrently
2. **Polling retry on callback** — 8 retries × 1.5 sec = 12 sec window before declaring failure. Stopped the duplicate-order false-positive that was causing customers to place second orders.
3. **State name normalizer** — handles "California" → "CA" so addresses with full state names don't blow Quiklie's 5-char limit
4. **Cumulative refund tracking** — partial refunds tracked in a separate column so multiple partials can never exceed the original total
5. **Amount-match webhook defense** — webhook payload's amount must equal stored order total before we mark paid; blocks forged-SUCCESS attacks if the API key ever leaks
6. **Customer-friendly decline messages** — gateway jargon translated to actionable English ("Your bank blocked an international transaction" → tells them to enable international charges)
7. **Idempotency keys** — UUID v4 reused across button double-clicks so the gateway dedupes duplicate submissions
8. **Phantom-order prevention** — orders only inserted AFTER Quiklie accepts the request, eliminating ghost rows that late webhooks could flip to paid
9. **$15 minimum guard** — clean customer-facing error instead of opaque gateway 400
10. **Constant-time API key comparison** — prevents timing-side-channel on webhook auth

### Known issues (gateway-side, not plugin-side)

- **CardsShield/KingsGate refund API returns `code 403`** for some merchants. Not a plugin issue — refund permissions need explicit enablement by the gateway team. See TROUBLESHOOTING.md for workaround (manual PayPal refund + DB update).
