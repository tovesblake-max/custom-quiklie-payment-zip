# 15-Minute Quickstart

The fastest path from zero to a working Quiklie checkout. Assumes you already have:

- A Next.js 14+ App Router project
- A SQL database with an `orders` table
- A Quiklie merchant account with credentials in hand

## Minute 0-2: Install + envs

```bash
npm install custom-quiklie-payment-zip zod
```

Create `.env.local`:

```env
QUIKLIE_MERCHANT_ID=171
QUIKLIE_API_KEY=your_real_key
QUIKLIE_WEBHOOK_API_KEY=your_real_key
QUIKLIE_DESCRIPTOR=YOUR DESCRIPTOR
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

## Minute 2-5: Copy the four route templates

```bash
mkdir -p app/api/checkout/quiklie-hpp app/api/checkout/result app/api/quiklie/notify app/api/admin/refund
cp node_modules/custom-quiklie-payment-zip/examples/api/checkout/quiklie-hpp/route.ts app/api/checkout/quiklie-hpp/route.ts
cp node_modules/custom-quiklie-payment-zip/examples/api/checkout/result/route.ts     app/api/checkout/result/route.ts
cp node_modules/custom-quiklie-payment-zip/examples/api/quiklie/notify/route.ts      app/api/quiklie/notify/route.ts
cp node_modules/custom-quiklie-payment-zip/examples/api/admin/refund/route.ts        app/api/admin/refund/route.ts
```

## Minute 5-10: Wire up the TODOs

In each of the 4 route files, search for `// ── TODO:` and replace with your DB calls + auth.

Minimum viable wiring (use Drizzle? swap for your ORM):

**`app/api/checkout/quiklie-hpp/route.ts`** — after the success path returns:

```ts
await db.insert(orders).values({
  orderNumber,
  email: user.email,
  total,
  paymentStatus: "unpaid",
  paymentGateway: "quiklie",
  quikliePaymentId: data.qkpaymentId,
  transactionRef: payload.idempotencyKey,
  shippingAddress: payload.shippingAddress,
});
```

**`app/api/quiklie/notify/route.ts`** — replace the order lookup stub:

```ts
let [order] = await db.select().from(orders)
  .where(eq(orders.transactionRef, transactionReferenceId!))
  .limit(1);
if (!order && quikliePaymentId) {
  [order] = await db.select().from(orders)
    .where(eq(orders.quikliePaymentId, quikliePaymentId))
    .limit(1);
}
```

And the SUCCESS branch:

```ts
const claimed = await db.update(orders)
  .set({ paymentStatus: "completed", status: "confirmed" })
  .where(and(
    eq(orders.id, order.id),
    inArray(orders.paymentStatus, ["unpaid", "pending"]),
  ))
  .returning({ id: orders.id });

if (claimed.length === 0) {
  return NextResponse.json({ ok: true, note: "concurrent completion" });
}

// Fire confirmation email, ShipStation push, etc. — fire-and-forget.
```

**`app/api/checkout/result/route.ts`** — replace the order lookup stub similarly. Look up by `orderNumber`.

**`app/api/admin/refund/route.ts`** — same pattern. Look up by `orderId`.

## Minute 10-13: Copy the components

```bash
mkdir -p app/components app/checkout/callback
cp node_modules/custom-quiklie-payment-zip/examples/components/PayWithCardButton.tsx     app/components/PayWithCardButton.tsx
cp node_modules/custom-quiklie-payment-zip/examples/components/QuiklieRedirectNotice.tsx app/components/QuiklieRedirectNotice.tsx
cp node_modules/custom-quiklie-payment-zip/examples/components/CheckoutCallback.tsx      app/checkout/callback/page.tsx
```

## Minute 13-15: Wire the checkout page

Create `app/checkout/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import PayWithCardButton from "../components/PayWithCardButton";
import QuiklieRedirectNotice from "../components/QuiklieRedirectNotice";

export default function CheckoutPage() {
  // Replace with your real cart state + shipping form
  const items = [
    { productId: "p1", productName: "Test Product", variantSku: "TEST-1",
      price: 2000, quantity: 1, slug: "test-product" },
  ];
  const [shippingAddress, setShippingAddress] = useState({
    firstName: "", lastName: "", address1: "",
    city: "", state: "", zip: "", country: "US",
  });
  const total = items.reduce((s, i) => s + i.price * i.quantity, 0);

  return (
    <div className="max-w-md mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">Checkout</h1>

      {/* Replace with your real shipping form */}
      <pre>{JSON.stringify(shippingAddress, null, 2)}</pre>

      <QuiklieRedirectNotice
        descriptor={process.env.NEXT_PUBLIC_QUIKLIE_DESCRIPTOR || "YOUR DESCRIPTOR"}
        supportEmail="support@your-site.com"
      />

      <PayWithCardButton
        items={items}
        shippingAddress={shippingAddress}
        totalDollars={total / 100}
      />
    </div>
  );
}
```

## Minute 15: Test

```bash
npm run dev
```

Visit http://localhost:3000/checkout, fill in the form, click Pay. You should redirect to Quiklie's hosted page.

## After it works locally

1. **Register the webhook URL** in Quiklie's dashboard: `https://your-site.com/api/quiklie/notify`
2. **Place one $15+ live order** with a real card
3. **Confirm**: charge appears, order shows `completed` in DB, confirmation email fires (if you wired one up)
4. **Test refund** via `/api/admin/refund`

You're live.
