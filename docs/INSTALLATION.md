# Installation Guide

Detailed walkthrough for getting Quiklie working on your Next.js site. If you've never set up a payment processor before or you're using Claude Code / Cursor / v0 to build, follow this step by step.

## Prerequisites

- **Next.js 14+ with App Router** (the `app/` directory, not `pages/`)
- **Node 20+**
- **A database** — any SQL database accessed via your ORM of choice. Examples in this guide use Drizzle ORM but the patterns work with Prisma, raw SQL, or anything else.
- **A Quiklie merchant account** with:
  - User ID (numeric, e.g. 171)
  - API Key (long alphanumeric)
  - Statement descriptor assigned (max 22 chars)
  - At least one active payment processor on your MID (this is the part Quiklie's onboarding handles — confirm with their team before going live)

## Step 1: Install the package

```bash
npm install custom-quiklie-payment-zip zod
# or
pnpm add custom-quiklie-payment-zip zod
# or
yarn add custom-quiklie-payment-zip zod
```

`zod` is a peer dependency for the route templates' input validation. If you already use it, no additional install needed.

## Step 2: Environment variables

Copy `.env.example` from the package into your project's `.env.local`:

```env
# Required
QUIKLIE_MERCHANT_ID=171
QUIKLIE_API_KEY=vcnMj...your_real_key
QUIKLIE_WEBHOOK_API_KEY=vcnMj...same_as_above_unless_quiklie_issued_a_separate_one
QUIKLIE_DESCRIPTOR=YOUR DESCRIPTOR
NEXT_PUBLIC_SITE_URL=https://your-site.com

# Optional
NEXT_PUBLIC_QUIKLIE_HPP_MIDTYPE=THREE_D   # or TWO_D
QUIKLIE_MIN_TXN_CENTS=1500                # default $15 minimum
```

**Production deployments (Vercel):**

```bash
vercel env add QUIKLIE_MERCHANT_ID production
vercel env add QUIKLIE_API_KEY production
vercel env add QUIKLIE_WEBHOOK_API_KEY production
vercel env add QUIKLIE_DESCRIPTOR production
vercel env add NEXT_PUBLIC_SITE_URL production
```

After adding env vars, **redeploy** — Vercel doesn't hot-reload env changes.

## Step 3: Database schema

The plugin needs your `orders` table to have these columns. If you already have an orders table, add the missing ones via a migration.

Drizzle schema example:

```ts
import { pgTable, uuid, varchar, integer, timestamp, jsonb, text } from "drizzle-orm/pg-core";

export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderNumber: varchar("order_number", { length: 50 }).notNull().unique(),
  email: varchar("email", { length: 255 }).notNull(),
  total: integer("total").notNull(), // cents

  // Required for Quiklie
  paymentStatus: varchar("payment_status", { length: 20 }).notNull().default("unpaid"),
  paymentGateway: varchar("payment_gateway", { length: 30 }),
  quikliePaymentId: varchar("quiklie_payment_id", { length: 100 }), // qkpaymentId from process-payment response
  transactionRef: varchar("transaction_ref", { length: 100 }),       // your idempotencyKey

  // For refunds
  refundedAmountCents: integer("refunded_amount_cents").notNull().default(0),

  shippingAddress: jsonb("shipping_address"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
```

If you're using Prisma:

```prisma
model Order {
  id                  String   @id @default(uuid())
  orderNumber         String   @unique
  email               String
  total               Int      // cents

  paymentStatus       String   @default("unpaid")
  paymentGateway      String?
  quikliePaymentId    String?
  transactionRef      String?

  refundedAmountCents Int      @default(0)

  shippingAddress     Json?
  notes               String?
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
}
```

## Step 4: Copy the route templates

The `examples/api/` folder mirrors the App Router layout. Copy these in:

```
examples/api/checkout/quiklie-hpp/route.ts  →  app/api/checkout/quiklie-hpp/route.ts
examples/api/checkout/result/route.ts       →  app/api/checkout/result/route.ts
examples/api/quiklie/notify/route.ts        →  app/api/quiklie/notify/route.ts
examples/api/admin/refund/route.ts          →  app/api/admin/refund/route.ts
```

Open each and search for `// ── TODO:` blocks. Each one tells you exactly what to replace with your DB call.

The most important TODOs:

1. **`/api/checkout/quiklie-hpp/route.ts`** → after `// ── TODO: PERSIST THE ORDER ──`, insert the order row in your DB.
2. **`/api/quiklie/notify/route.ts`** → after `// ── TODO: REPLACE THIS BLOCK WITH YOUR DB LOOKUP ──`, look up the order by `transactionReferenceId` (primary) or `quikliePaymentId` (fallback). Then after `// ── TODO: ATOMIC COMPLETION CLAIM ──`, the conditional UPDATE that prevents double-firing.
3. **`/api/checkout/result/route.ts`** → after `// ── TODO: LOOK UP THE ORDER FOR THIS USER ──`, the auth-scoped order lookup.

## Step 5: Copy the React components

```
examples/components/PayWithCardButton.tsx       →  app/components/PayWithCardButton.tsx
examples/components/QuiklieRedirectNotice.tsx   →  app/components/QuiklieRedirectNotice.tsx
examples/components/CheckoutCallback.tsx        →  app/checkout/callback/page.tsx
```

The components use Tailwind classes — adapt to your styling system if you don't use Tailwind.

## Step 6: Wire up the checkout page

```tsx
"use client";

import PayWithCardButton from "@/components/PayWithCardButton";
import QuiklieRedirectNotice from "@/components/QuiklieRedirectNotice";
import { useCart } from "@/lib/your-cart-hook";

export default function CheckoutPage() {
  const { items, total } = useCart();
  const [shippingAddress, setShippingAddress] = useState<ShippingAddress>(...);

  return (
    <div>
      <YourShippingForm onChange={setShippingAddress} />

      {/* Pre-pay heads-up */}
      <QuiklieRedirectNotice
        descriptor={process.env.NEXT_PUBLIC_QUIKLIE_DESCRIPTOR || "YOUR DESCRIPTOR"}
        supportEmail="support@your-site.com"
      />

      {/* Pay button — full-page redirect to Quiklie's hosted page */}
      <PayWithCardButton
        items={items}
        shippingAddress={shippingAddress}
        totalDollars={total / 100}
      />
    </div>
  );
}
```

## Step 7: Register the webhook in Quiklie

In your Quiklie merchant dashboard:

1. Navigate to **Settings → Webhooks** (or "Notification URL" depending on dashboard version)
2. Set the URL to: `https://your-site.com/api/quiklie/notify`
3. Save

Without this, you'll only know about successful payments via polling (slow). With it, you get push notifications within ~1 second of payment finalizing. See [WEBHOOK_SETUP.md](./WEBHOOK_SETUP.md) for the full justification.

## Step 8: Test with a $15+ order

Quiklie has a $15 minimum on the merchant accounts we've seen — verify with your account manager. Place a test order:

1. Go to your `/checkout` page
2. Enter test address
3. Click "Pay via Card"
4. Should redirect to `pay.quiklie.com` (or similar)
5. Enter a real card (test cards aren't supported on production processors)
6. Complete the payment
7. Should bounce back to `/checkout/callback` showing success

If the callback shows "Still verifying your payment" → check the Quiklie dashboard. If the order shows as paid there but not on your `/checkout/callback` page, your webhook URL isn't registered or your `/api/quiklie/notify` endpoint is rejecting requests. See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## Step 9: Production cutover

1. Verify all env vars are set in your production deployment
2. Verify the webhook URL points to your production domain (not staging/preview)
3. Place one $15+ live order with a real card — confirm:
   - Charge appears on your card statement under the configured descriptor
   - Order shows as `completed` in your DB
   - Confirmation email fires (if you wired one up in the webhook handler's TODO)
   - Order shows up in your fulfillment system (if connected)
4. Refund the test order via the admin endpoint to verify the refund flow works end-to-end

You're live.
