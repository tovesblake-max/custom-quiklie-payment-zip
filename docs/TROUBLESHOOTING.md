# Troubleshooting

Real-world issues we hit during 6+ months of production Quiklie integration, and how we fixed each one. If you hit a symptom not in this doc, check `docs/WEBHOOK_SETUP.md` for webhook-specific issues.

## Customer sees "payment failed" but their card was charged

**Symptom:** Customer completes payment on Quiklie's hosted page, gets redirected back to your `/checkout/callback`, sees a failure or "still verifying" message, thinks it didn't go through, places a SECOND order. You end up refunding the duplicate.

**Root cause:** Race condition between the webhook and the customer's browser redirect. The webhook is supposed to write `paymentStatus = "completed"` but the customer's `/checkout/callback` page can land milliseconds before that write finishes. A single-shot fetch during that window legitimately reads "unpaid" → callback shows failure.

**Fix:** Make sure your `CheckoutCallback` component **polls** `/api/checkout/result` repeatedly (not single-shot). The plugin's template polls up to 8 times at 1.5-second spacing (~12 sec total) before declaring failure. Also make sure `/api/checkout/result` falls back to polling Quiklie's transaction-status API when the order is still `unpaid` in your DB.

```ts
// Wrong (single shot — race-loses):
const data = await fetch("/api/checkout/result").then(r => r.json());
if (data.status !== "completed") setStatus("failed");

// Right (polls until resolved):
let attempts = 0;
async function poll() {
  attempts += 1;
  const data = await fetch("/api/checkout/result").then(r => r.json());
  if (data.status === "completed") return setStatus("success");
  if (data.status === "pending" && attempts < 8) {
    return setTimeout(poll, 1500);
  }
  setStatus("failed");
}
poll();
```

The `examples/components/CheckoutCallback.tsx` template has this baked in.

## "No eligible payment processors available" (statusCode 5)

**Symptom:** Every HPP request returns `status: FAILED, statusCode: 5, message: "No eligible payment processors available for the requested transaction"`.

**Root cause:** Your Quiklie merchant account isn't provisioned against any payment processor yet. This isn't a code issue — it's an onboarding state.

**Fix:** Email Quiklie support: *"We're getting `No eligible payment processors available` (statusCode 5) on every HPP request to MID [your_id], regardless of midType. Can you confirm the MID is provisioned against at least one processor?"* They flip a switch on their side.

Verify before going live: place one $15+ test transaction with real cards. If it succeeds, your MID is good. If it fails with statusCode 5, your MID needs provisioning.

## "state must be 1-5 characters"

**Symptom:** Some checkouts fail with `{"state":"state must be 1-5 characters"}` from Quiklie.

**Root cause:** Customer's address has a full state name ("California") instead of the 2-letter USPS code ("CA"). Quiklie hard-rejects.

**Fix:** The plugin's API client (`processPaymentHPP` and `processPaymentS2S`) automatically normalizes via `normalizeUSStateCode()`. If you're STILL seeing this error, either:

1. You're calling the Quiklie API directly without going through the plugin's client (don't do this — use the plugin)
2. You're storing addresses with malformed states that even the normalizer can't recover. Check what's in your DB.

You should also enforce 2-letter codes at the input layer:

```tsx
<input
  maxLength={2}
  value={state}
  onChange={(e) => setState(
    e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2)
  )}
/>
```

## Refund returns `code 403, no message`

**Symptom:** Calling `processRefund()` (or hitting `/api/admin/refund`) returns CardsShield-style `code: 403, msg: ""`. Charges work fine; only refunds fail.

**Root cause:** Refund API access isn't enabled on your merchant account, OR your `CS_SECRET_KEY` doesn't match what the gateway expects for refunds (some processors use a different secret for refund HMAC than for the inbound payment APIs).

**Fix:** Email Quiklie support: *"Our calls to the refund endpoint return `code 403` with no message. Charges + tracking sync work fine. Can you confirm refund API access is provisioned for our account, and that we should be using `[your_secret_var_name]` for the refund HMAC?"*

While they investigate: refund manually through PayPal's merchant dashboard (the underlying processor under Quiklie's hood). Find the transaction by `qkpaymentId` (or its PayPal-side ID — check the order's `cs_trade_no` if you have it stored). After the manual refund clears, update your DB to mark `refunded_amount_cents`.

## Customer's bank declines with "transaction declined by authorisation system"

**Symptom:** Customer hits the Pay button, sees a generic decline. They didn't lose connection or do anything wrong.

**Root cause:** Their card issuer has international transactions disabled. Quiklie's HPP routes through an international acquirer (DTF HORIZONTRV in our case), so any US card whose issuer hasn't opted into international charges gets rejected before the transaction even hits Quiklie.

**Fix:**

1. **Show the warning BEFORE pay.** That's exactly what `<QuiklieRedirectNotice>` does — tells the customer to enable international payments on their card before clicking. Don't skip this component.
2. **Translate the decline message** in your callback page. The plugin's `translateQuiklieDecline()` maps the gateway jargon to actionable customer English:

   > *"Your bank blocked an international transaction. Open your banking app or call the number on the back of your card and enable international transactions, then try paying again."*

   Customers who get this message can usually fix it themselves in 60 seconds via their banking app.

## Webhook returns 200 but order never updates to "completed"

**Symptom:** Quiklie's dashboard shows your webhook URL is being delivered successfully (200 response). But your order rows still say `paymentStatus = "unpaid"`.

**Root cause:** The webhook handler is finding the order, validating the signature, parsing the status code correctly... and then your TODO block to actually UPDATE the DB is missing or buggy.

**Fix:** Check `/api/quiklie/notify/route.ts` — the `// ── TODO: ATOMIC COMPLETION CLAIM ──` block. The template has explicit pseudocode showing the conditional UPDATE. If you skipped it, payments succeed but never persist.

```ts
// Drizzle example:
const claimed = await db.update(orders)
  .set({
    paymentStatus: "completed",
    status: "confirmed",
    quikliePaymentId: quikliePaymentId || order.quikliePaymentId,
  })
  .where(and(
    eq(orders.id, order.id),
    inArray(orders.paymentStatus, ["unpaid", "pending"]),
  ))
  .returning({ id: orders.id });

if (claimed.length === 0) {
  // Concurrent caller already completed — exit clean
  return NextResponse.json({ ok: true, note: "concurrent completion handled" });
}

// ... fire side-effects HERE (only when we won the claim) ...
```

## "Card payments require a minimum order of $15"

**Symptom:** Customer's cart is under $15 and they hit the minimum-amount gate.

**Root cause:** Quiklie's acquirer has a hard $15 floor. The plugin enforces this client-side with a clean error before the API call.

**Fix:** This is intentional — the API would reject the same transaction with a confusing error if you didn't gate it. Either:

1. Bump the cart total above $15 (add a min-order requirement to your shop)
2. Offer ACH or another fee-free rail for sub-$15 orders
3. Lower the `QUIKLIE_MIN_TXN_CENTS` env var if Quiklie has reduced your floor

## Charges don't show as "DTF HORIZONTRV" — they show as something else

**Symptom:** Customer's bank statement shows a different merchant name than what your `<QuiklieRedirectNotice>` says.

**Root cause:** Your `QUIKLIE_DESCRIPTOR` env var doesn't match what Quiklie's acquirer is actually setting on the charge. The descriptor is configured at the acquirer level — your env var has to match the acquirer's setup exactly.

**Fix:** Email Quiklie support to confirm the assigned descriptor. Update your env var (and the prop you pass to `<QuiklieRedirectNotice>`) to match.

## Tests / preview deployments breaking on cold start

**Symptom:** Local dev or Vercel preview deployments throw `JWT_SECRET environment variable is required in production` or similar at app boot.

**Root cause:** The plugin's `getJwtSecret`-style helpers throw on cold start in non-dev environments. Preview deployments report `process.env.NODE_ENV === "production"` even though they're not your real production.

**Fix:** The plugin's helpers are scoped to throw only when `NODE_ENV === "production" && NEXT_PHASE !== "phase-production-build"`. If you're hitting this on Vercel previews, make sure your Quiklie env vars are set in the Preview environment, not just Production.

## Catalog match rate dropping in Meta Ads Manager

If you're running Meta ads with a product catalog, and pixel events fire with content_ids that aren't in your feed, your Catalog Match Rate metric drops below 90% (Meta's threshold for Advantage+ ad targeting).

This isn't a Quiklie issue per se, but it's a common downstream effect: your Quiklie checkout fires Pixel/CAPI Purchase events with the variantSku, and if those SKUs aren't in your Meta product feed, every event is a miss.

**Fix:** Filter pixel/CAPI events to feed-eligible products only. The plugin's source repo has a `meta-eligibility` helper you can model after — single source of truth for "what's in the feed?" used by both the feed XML route AND the event-firing call sites.
