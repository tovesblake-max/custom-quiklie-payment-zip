# Webhook Setup Guide

## Why the webhook matters

Quiklie's HPP flow has two channels for telling you about a transaction's outcome:

1. **Push (webhook)** — Quiklie POSTs to your `/api/quiklie/notify` URL the moment the result is known
2. **Pull (polling)** — Your code calls Quiklie's `/api/v1/transaction-status/{id}` endpoint asking "did this finalize?"

The plugin uses **both** in a dual-channel pattern, but the webhook is the primary signal. Without the webhook registered, you're operating with only the safety net.

### What happens without the webhook

Customer redirects to Quiklie's hosted page, pays, and gets bounced back to `/checkout/callback`. The callback page polls `/api/checkout/result` which polls Quiklie's status API as a fallback. **That works**, but only while the customer is sitting on the callback page. If they:

- Close the tab mid-3DS
- Lose connection between Quiklie and your callback page
- Bounce off to check email
- Complete 3DS in their banking app instead of the browser

...then the polling stops and the order sits in `unpaid` in your DB. Your fulfillment doesn't fire. Confirmation email doesn't send. Customer thinks the order didn't go through and either contacts support or, more often, **places a second order**.

We watched this exact failure mode hit three real customers in a single day before we registered the webhook. Don't skip this step.

### What you get with the webhook

The instant the issuer returns a verdict, Quiklie POSTs your endpoint. Sub-second latency. Works regardless of what the customer's browser is doing.

| Side-effect | Without webhook (polling only) | With webhook |
|---|---|---|
| Order flipped to `completed` | Up to 6h (cron reconcile) | < 1 sec |
| Confirmation email | Up to 6h | < 1 sec |
| Fulfillment push (ShipStation, etc.) | Up to 6h | < 1 sec |
| Admin SMS notification | Up to 6h | < 1 sec |
| Meta Pixel / GA4 Purchase event | Up to 6h | < 1 sec |
| Affiliate commission recorded | Up to 6h | < 1 sec |

## Setup steps

### 1. Make sure your `/api/quiklie/notify` route is deployed and reachable

```bash
curl -X POST https://your-site.com/api/quiklie/notify \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected response: `{"error":"Unauthorized"}` with HTTP 401. **That's correct** — the endpoint is rejecting requests without a valid `x-api-key` header. If you get a 404, the route isn't deployed. If you get a 500, check your server logs.

### 2. Register the URL with Quiklie

In your Quiklie merchant dashboard:

1. Log in
2. Navigate to **Settings → Webhooks** (the exact menu name varies by dashboard version — look for "Notification URL" if you don't see "Webhooks")
3. Add: `https://your-site.com/api/quiklie/notify`
4. Save

If you can't find the setting, email Quiklie support: *"Please configure our notification URL to https://your-site.com/api/quiklie/notify for merchant ID [your_id]."*

### 3. Verify the webhook key

The plugin's notify route validates the incoming `x-api-key` header against `QUIKLIE_WEBHOOK_API_KEY` (or falls back to `QUIKLIE_API_KEY`). For most Quiklie merchants these are the same value.

If Quiklie issued you a separate webhook secret, set `QUIKLIE_WEBHOOK_API_KEY` explicitly.

### 4. Test end-to-end

Place a $15+ test order with a real card. Watch your server logs.

Expected log sequence:

```
[POST /api/checkout/quiklie-hpp] → 200 OK (returns redirectUrl)
... customer redirects to Quiklie, pays ...
[POST /api/quiklie/notify] → 200 OK (with status=SUCCESS, statusCode=1)
[GET /checkout/callback?order_number=...] → 200 OK
[POST /api/checkout/result] → 200 OK (returns status=completed)
```

If the `/api/quiklie/notify` line never appears, the webhook isn't registered or Quiklie isn't reaching your domain. Check Quiklie's webhook delivery log (in their dashboard) for failed delivery attempts.

## Troubleshooting

### Webhook returns 401

Your `QUIKLIE_WEBHOOK_API_KEY` env var doesn't match what Quiklie is sending. Confirm with Quiklie support which key they POST with.

### Webhook returns 400 "Amount mismatch"

The webhook's amount field doesn't match the order's stored total. Causes:
- You stored the order total in dollars but Quiklie is reporting cents (or vice versa)
- Currency conversion happened between order creation and payment
- The webhook is a replay of an old transaction with a different amount

The notify route logs both expected and received amounts when this happens — check your logs.

### Webhook returns 200 but order doesn't update

Look at the response body for a `note` field:
- `"already processed"` → order was already in a terminal state. Webhook is a duplicate or replay.
- `"order not found"` → the `transactionReferenceId` and `quikliePaymentId` don't match any row in your DB. Check the column names in your TODO blocks — most often this is because the WRITE side (checkout route) is storing the ref in a different column than the READ side (webhook lookup).
- `"unparseable status"` → Quiklie sent a status code we don't recognize. Add it to the spec or contact Quiklie.
- `"concurrent completion already handled"` → atomic claim correctly prevented a double-fire. This is fine.

### Webhook never arrives

Most common cause: webhook URL wasn't actually saved in Quiklie's dashboard. Sign in to Quiklie, double-check.

Second most common: your domain has a firewall or Vercel preview-deployment auth blocking POST traffic. Verify the URL is publicly reachable: `curl -X POST <url>` should return 401, not 403/timeout/auth-redirect.

### Lots of webhook 200 responses but customers still see "still verifying"

Race condition where the customer's browser landed on `/checkout/callback` before the webhook finished writing. The plugin's CheckoutCallback component polls 8 times at 1.5s spacing (~12 sec total) before declaring failure — should mask all but the slowest webhook deliveries. If this is happening consistently:

- Check your DB write latency in the webhook (some ORMs do extra round-trips on first call)
- Check the webhook handler isn't doing slow side-effects synchronously (email sends, ShipStation pushes, etc. should all be fire-and-forget with `.catch()`)
- Pre-warm the serverless function so cold starts don't add 2-3 sec to webhook handling
