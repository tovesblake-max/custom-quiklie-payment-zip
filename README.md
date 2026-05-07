# Custom Quiklie Payment Zip

> Drop-in Quiklie payment gateway integration for Next.js 14+ (App Router) — extracted from a live merchant stack after 6 months of production card volume. Built for AI-assisted (Claude Code, Cursor, v0) and human-built sites.

**npm:** `custom-quiklie-payment-zip` &nbsp;·&nbsp; **GitHub:** [tovesblake-max/custom-quiklie-payment-zip](https://github.com/tovesblake-max/custom-quiklie-payment-zip)

Includes HPP checkout, S2S admin tooling, webhook receiver, refund flow, OTP verification, transaction-status fallback poll, plus React components for the buy button + customer-facing redirect notice + race-safe callback page.

> **Why this exists:** Quiklie's official integration is a WooCommerce plugin. If you're building on Next.js (especially with Claude Code, v0, Cursor, or any AI-assisted stack), you need something framework-native. This package is the production code from a live merchant doing real card volume — not an example, not a demo.

---

## What's included

```
src/
├── lib/
│   ├── quiklie.ts                      Core API client (HPP, S2S, refund, OTP, status)
│   ├── quiklie-webhook.ts              Webhook validation + status code parsing
│   ├── us-states.ts                    State name → 2-letter USPS code normalizer
│   └── quiklie-decline-messages.ts     Customer-friendly decline-reason translation
├── index.ts                            Public exports

examples/
├── api/
│   ├── checkout/
│   │   ├── quiklie-hpp/route.ts        HPP checkout endpoint
│   │   └── result/route.ts             Order-status poll endpoint
│   ├── quiklie/
│   │   ├── notify/route.ts             Webhook receiver
│   │   ├── verify-otp/route.ts         OTP verification (rare)
│   │   └── transaction-status/route.ts Status poll proxy
│   └── admin/
│       └── refund/route.ts             Admin-initiated refund
├── components/
│   ├── PayWithCardButton.tsx           "Pay with Card" button → HPP redirect
│   ├── QuiklieRedirectNotice.tsx       Pre-pay heads-up (DTF descriptor, intl cards)
│   └── CheckoutCallback.tsx            /checkout/callback page with race-safe polling

docs/
├── INSTALLATION.md
├── WEBHOOK_SETUP.md
└── TROUBLESHOOTING.md
```

---

## Quick start (15 minutes)

### 1. Install

```bash
npm install custom-quiklie-payment-zip zod
```

### 2. Set environment variables

Copy `.env.example` → `.env.local` and fill in:

```env
QUIKLIE_MERCHANT_ID=171              # from Quiklie dashboard → Profile
QUIKLIE_API_KEY=...                  # from Quiklie dashboard → Profile
QUIKLIE_WEBHOOK_API_KEY=...          # usually same as QUIKLIE_API_KEY
QUIKLIE_DESCRIPTOR=YOUR DESCRIPTOR   # what shows on customer's statement (max 22 chars)
NEXT_PUBLIC_SITE_URL=https://your-site.com
```

### 3. Copy the route templates

The `examples/api/` folder mirrors the Next.js App Router layout. Copy these into your `app/` directory:

```
examples/api/checkout/quiklie-hpp/route.ts  →  app/api/checkout/quiklie-hpp/route.ts
examples/api/quiklie/notify/route.ts        →  app/api/quiklie/notify/route.ts
examples/api/checkout/result/route.ts       →  app/api/checkout/result/route.ts
examples/api/admin/refund/route.ts          →  app/api/admin/refund/route.ts
```

Each template has clearly-marked `// ── TODO: ──` blocks where you wire in your DB calls and auth. Everything else (gateway calls, validation, state normalization, race-safe completion) is production-tested and works as-is.

### 4. Copy the React components

```
examples/components/PayWithCardButton.tsx       →  app/components/PayWithCardButton.tsx
examples/components/QuiklieRedirectNotice.tsx   →  app/components/QuiklieRedirectNotice.tsx
examples/components/CheckoutCallback.tsx        →  app/checkout/callback/page.tsx
```

### 5. Wire up the checkout page

```tsx
import PayWithCardButton from "./components/PayWithCardButton";
import QuiklieRedirectNotice from "./components/QuiklieRedirectNotice";

export default function CheckoutPage() {
  return (
    <div>
      <QuiklieRedirectNotice descriptor="YOUR DESCRIPTOR" />
      <PayWithCardButton
        items={cartItems}
        shippingAddress={addr}
        totalDollars={totalDollars}
      />
    </div>
  );
}
```

### 6. Register the webhook URL in Quiklie

In your Quiklie merchant dashboard, set the **Notification URL** to:

```
https://your-site.com/api/quiklie/notify
```

That's it. See [docs/WEBHOOK_SETUP.md](./docs/WEBHOOK_SETUP.md) for the full setup walkthrough.

---

## What this plugin solves that the WooCommerce plugin doesn't

This was originally extracted from a live Next.js + Drizzle + Vercel stack after we hit (and fixed) every one of the WordPress plugin's known bugs:

| Issue (from Quiklie WP plugin v2.1.x changelog) | How this package handles it |
|---|---|
| Duplicate `payment_complete()` calls (race between webhook + return + poller) | **Atomic completion claim** in the webhook + result-poll routes. Only one caller wins; concurrent callers exit clean. Templates show the conditional UPDATE pattern. |
| Non-unique transaction reference IDs (`time()` collisions) | Uses a client-supplied 16–64 char hex `idempotencyKey` (UUIDv4). Crypto-random per attempt. |
| Text status codes bypassing `is_paid()` guard | `parseQuiklieStatusCode()` normalizes `"SUCCESS"` → `1` BEFORE any guard runs. |
| Refund API never called (silent failure) | `processRefund()` ships in the API client, wired to `POST /api/v1/refund`. Admin refund route template uses it. |
| Cart emptied before payment confirmed | The `PayWithCardButton` deliberately does NOT clear the cart on redirect — only on confirmed completion via the callback page. |
| Customer sees "payment failed" even when payment succeeded | **Race-safe polling on the callback page** — up to 8 retries at 1.5s spacing before declaring failure. This is what stopped the duplicate-order incidents. |
| State field too long → gateway 400 | `normalizeUSStateCode()` handles full state names, punctuation, whitespace. Applied automatically inside the API client. |
| Confusing decline messages | `translateQuiklieDecline()` maps known patterns to actionable customer messages ("Your bank blocked an international transaction" instead of "Transaction declined by authorisation system"). |

---

## Architecture overview

```
                     ┌──────────────────────────────────────────────────┐
                     │  CUSTOMER BROWSER                                │
                     │                                                  │
                     │  /checkout                                       │
                     │  ├── <PayWithCardButton>                         │
                     │  │     POST {items, address}                     │
                     │  │     ─────────────────────────►   /api/checkout/quiklie-hpp
                     │  │                                  ├── creates order (paymentStatus="unpaid")
                     │  │                                  └── calls processPaymentHPP()
                     │  │                                  ─────────────────────────► api.quiklie.com
                     │  │     ◄────────────  redirectUrl ────────────────                 │
                     │  └── window.location = redirectUrl                                 │
                     │                                                                    │
                     │  pay.quiklie.com (hosted card-entry page) ◄────────────────────────┘
                     │  ├── Customer enters card details
                     │  ├── 3DS / OTP if required
                     │  └── Quiklie processes payment
                     │                                  ┌──────────────────────────────────┐
                     │                                  │                                  ▼
                     │  /checkout/callback ◄────────── │            /api/quiklie/notify  (webhook)
                     │  ├── <CheckoutCallback>          │            ├── validates X-API-Key
                     │  │     POST {orderNumber}        │            ├── amount-matches order total
                     │  │     ────────────►  /api/checkout/result    ├── atomic UPDATE paymentStatus
                     │  │                    ├── reads order DB     │  └── fires side-effects
                     │  │                    └── falls back to polling Quiklie
                     │  │                       getTransactionStatus()
                     │  │     ◄──── status: "completed" / "pending" / "failed"
                     │  │
                     │  └── retries up to 8 times (1.5s spacing) before declaring failure
                     └──────────────────────────────────────────────────────────────────┘
```

The dual-channel pattern (webhook push + status-poll fallback) is what makes this race-safe. The webhook is the primary signal; the poll is the safety net for orders where the customer's browser landed on the callback page before the webhook had time to finish writing the DB.

---

## Supported flows

- ✅ **HPP (Hosted Payment Page)** — primary flow. PCI SAQ-A. Customer redirects to Quiklie's hosted page.
- ✅ **S2S (Server-to-Server)** — kept in the API client for admin tooling. PCI SAQ-D — DO NOT use as customer-facing path.
- ✅ **3DS challenges** — handled automatically by Quiklie's HPP page.
- ✅ **OTP fallback** — `/api/quiklie/verify-otp` template included. Rare in modern card flows.
- ✅ **Refunds** — full + partial. Atomic claim, cumulative tracking, gateway error surfacing.
- ✅ **Reconcile cron** (recommended) — for picking up orders where the webhook never landed. See [TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md).

---

## License

MIT. Use it, fork it, ship it.
