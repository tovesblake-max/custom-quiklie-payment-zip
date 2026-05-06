/**
 * Quiklie HPP (Hosted Payment Page) checkout route — TEMPLATE.
 *
 * Drop this at: app/api/checkout/quiklie-hpp/route.ts
 *
 * Flow:
 *   1. Client POSTs cart + shipping address to this route. NO card data.
 *   2. We create a pending order row (paymentStatus="unpaid") only AFTER
 *      Quiklie accepts the HPP request — same "no phantom order" pattern
 *      we use for every gateway.
 *   3. Quiklie returns a redirect URL — the client navigates the customer
 *      there to enter card details on Quiklie's domain.
 *   4. Quiklie posts the final result to /api/quiklie/notify; that route
 *      flips paymentStatus → "completed" and triggers fulfillment.
 *   5. Customer is redirected back to /checkout/callback for confirmation.
 *
 * This is a TEMPLATE — replace the TODO blocks with your auth, DB, and
 * order-management logic. Everything else is production-tested.
 */
import { NextResponse } from "next/server";
import { processPaymentHPP, QUIKLIE_STATUS } from "custom-quiklie-payment-zip";
import { z } from "zod";

// ── INPUT SCHEMA ─────────────────────────────────────────────
// Validate the cart shape coming from the client. Adjust fields for
// your product model — what's required is `items[].price` (cents) and
// `shippingAddress` with the fields shown.
const checkoutSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string(),
        productName: z.string(),
        variantSku: z.string(),
        price: z.number(),
        quantity: z.number().min(1),
        slug: z.string(),
      }),
    )
    .min(1),
  shippingAddress: z.object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    address1: z.string().min(1),
    address2: z.string().optional(),
    city: z.string().min(1),
    state: z.string().min(1),
    zip: z.string().min(1),
    country: z.string().default("US"),
  }),
  // Client-generated idempotency key — also reused as the Quiklie
  // transactionReferenceId so Quiklie dedupes in concert with us.
  // Required: minimum 16 chars hex (UUID v4 fits perfectly).
  idempotencyKey: z.string().regex(/^[a-fA-F0-9-]{16,64}$/),
});

function generateOrderNumber(): string {
  const now = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ORDER-${now}${rand}`;
}

export async function POST(request: Request) {
  // ── TODO: AUTH ─────────────────────────────────────────────
  // Replace with your auth — the plugin doesn't care which scheme.
  // Example:
  //   const user = await requireAuth();
  //   if (!user.email) return NextResponse.json({ error: "..." }, { status: 400 });
  const user = { id: "anonymous", email: "guest@example.com", phone: undefined };

  let payload: z.infer<typeof checkoutSchema>;
  try {
    const body = await request.json();
    const parsed = checkoutSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    payload = parsed.data;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Compute totals. Replace with your pricing logic — shipping, fees,
  // taxes, discounts, etc.
  const subtotal = payload.items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0,
  );
  const shippingCents = subtotal >= 20000 ? 0 : 1499; // example: $200 free-ship threshold
  const total = subtotal + shippingCents;

  // Quiklie minimum-transaction guard. Quiklie's acquirer rejects
  // amounts under $15 with an opaque error; bail early with a clean
  // customer-facing message instead.
  const QUIKLIE_MIN_CENTS = Number(process.env.QUIKLIE_MIN_TXN_CENTS) || 1500;
  if (total < QUIKLIE_MIN_CENTS) {
    return NextResponse.json(
      {
        error: `Card payments require a minimum order of $${(QUIKLIE_MIN_CENTS / 100).toFixed(2)}. Add another item to your cart, or use an alternative payment method.`,
      },
      { status: 400 },
    );
  }

  const orderNumber = generateOrderNumber();
  const siteUrl = (
    process.env.NEXT_PUBLIC_SITE_URL || "https://your-site.com"
  ).replace(/\/+$/, "");

  // Reuse the client-supplied idempotencyKey as the Quiklie transaction
  // reference — double-clicks on the Pay button reuse the same key so
  // Quiklie dedupes the second submit instead of minting a second
  // hosted-page session.
  const transactionRef = payload.idempotencyKey;

  // midType selects the processor lane. THREE_D = 3DS-enabled (default
  // for fresh-card transactions); TWO_D = no-3DS (faster, but only
  // available on processors that don't enforce SCA). Override via env.
  const midType =
    process.env.NEXT_PUBLIC_QUIKLIE_HPP_MIDTYPE === "TWO_D"
      ? ("TWO_D" as const)
      : ("THREE_D" as const);

  // Statement descriptor — what shows on the customer's bank statement.
  // Capped at 22 chars by Quiklie. Get this assigned by Quiklie when
  // your MID is provisioned (e.g. "DTF HORIZONTRV").
  const descriptor = (process.env.QUIKLIE_DESCRIPTOR || "").slice(0, 22);

  // Get the client IP from Vercel / Cloudflare / your proxy headers.
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "0.0.0.0";

  const quiklieRes = await processPaymentHPP({
    amountDollars: total / 100,
    billing: {
      firstName: payload.shippingAddress.firstName,
      lastName: payload.shippingAddress.lastName,
      email: user.email,
      phone: user.phone,
      address: payload.shippingAddress.address1,
      zipCode: payload.shippingAddress.zip,
      city: payload.shippingAddress.city,
      state: payload.shippingAddress.state,
      country: payload.shippingAddress.country || "US",
    },
    callbackUrl: `${siteUrl}/api/quiklie/notify`,
    redirectUrl: `${siteUrl}/checkout/callback?order_number=${orderNumber}`,
    ipAddress: ip,
    customerReferenceId: `CUST-${user.id.slice(0, 8)}`,
    transactionReferenceId: transactionRef,
    midType,
    descriptor: descriptor || undefined,
  });

  if (!quiklieRes.ok || !quiklieRes.data) {
    // Gateway never accepted — bail WITHOUT inserting an order row.
    // No phantom order means no risk of a late webhook flipping a ghost
    // record to paid.
    const rawExcerpt = quiklieRes.raw?.slice(0, 500) || "";
    const parsedMessage =
      (quiklieRes.data as { message?: string } | null)?.message ||
      rawExcerpt ||
      "Quiklie gateway unreachable";
    console.warn("[Quiklie HPP] gateway error", {
      orderNumber,
      http_status: quiklieRes.status,
      message: parsedMessage,
    });
    return NextResponse.json(
      {
        orderNumber,
        error: "Payment gateway unavailable. Please try again or contact support.",
      },
      { status: 502 },
    );
  }

  const data = quiklieRes.data;
  const statusCode = Number(data.statusCode);
  const redirectUrl = data.quikleeRedirectUrl;

  // For HPP we always expect a redirect URL — the customer hasn't
  // entered card details yet, so an immediate SUCCESS / DECLINED
  // shouldn't happen. If Quiklie returned no redirect URL, treat it
  // like a gateway error.
  if (!redirectUrl) {
    console.warn("[Quiklie HPP] no redirect URL returned", {
      orderNumber,
      statusCode,
      message: data.message,
    });
    return NextResponse.json(
      {
        orderNumber,
        error: "Payment gateway returned no redirect URL. Please try again.",
      },
      { status: 502 },
    );
  }

  // ── TODO: PERSIST THE ORDER ────────────────────────────────
  // Insert a pending order row in your DB. The webhook (/api/quiklie/
  // notify) will flip it to "completed" when Quiklie reports the final
  // outcome. Required columns:
  //   - orderNumber                     (primary key for customer-facing references)
  //   - email, total, items, shippingAddress
  //   - paymentStatus = "unpaid"        (will be flipped by webhook)
  //   - paymentGateway = "quiklie"
  //   - quikliePaymentId = data.qkpaymentId   (Quiklie's internal id)
  //   - transactionRef = payload.idempotencyKey  (used as webhook lookup key)
  //
  // Example with a Drizzle ORM:
  //   await db.insert(orders).values({
  //     orderNumber,
  //     email: user.email,
  //     total,
  //     paymentStatus: "unpaid",
  //     paymentGateway: "quiklie",
  //     quikliePaymentId: data.qkpaymentId,
  //     transactionRef: payload.idempotencyKey,
  //     shippingAddress: payload.shippingAddress,
  //     // ... rest of your order fields
  //   });

  return NextResponse.json({
    orderNumber,
    total,
    method: "quiklie",
    status: "redirect",
    redirectUrl,
    quikliePaymentId: data.qkpaymentId,
  });
}
