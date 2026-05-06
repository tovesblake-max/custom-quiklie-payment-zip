/**
 * Quiklie callback webhook — TEMPLATE.
 *
 * Drop this at: app/api/quiklie/notify/route.ts
 *
 * Per Quiklie spec their only auth is an `X-API-Key` header — there is
 * no HMAC signature on the body. We harden the endpoint in three
 * complementary ways:
 *
 *   1. Constant-time compare of the API key (prevents timing oracles)
 *   2. Correlation by `transactionReferenceId` → our internal order ID,
 *      with strict terminal-state replay guards
 *   3. Amount match: the webhook payload's `amount` (dollars) must equal
 *      the order's stored total. If the API key ever leaks, an attacker
 *      still can't forge a SUCCESS for an arbitrary order without also
 *      knowing its exact total.
 *
 * Pure parsing helpers come from the plugin; the DB writes + side-
 * effects (confirmation email, fulfillment push, etc.) are TODOs you
 * fill in for your stack.
 */
import { NextResponse } from "next/server";
import {
  parseQuiklieStatusCode,
  amountMatches,
  safeEqual,
  QUIKLIE_WEBHOOK_STATUS,
} from "custom-quiklie-payment-zip";

export async function POST(request: Request) {
  // ── 1. Auth ────────────────────────────────────────────────
  const expectedKey =
    process.env.QUIKLIE_WEBHOOK_API_KEY || process.env.QUIKLIE_API_KEY;
  const provided = request.headers.get("x-api-key");
  if (!expectedKey || !provided || !safeEqual(provided, expectedKey)) {
    console.warn("[Quiklie Notify] rejected: bad or missing x-api-key header");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── 2. Parse body ──────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const transactionReferenceId =
    typeof body.transactionReferenceId === "string"
      ? body.transactionReferenceId
      : null;
  const quikliePaymentId =
    typeof body.transactionId === "string" ? body.transactionId : null;
  const status = typeof body.status === "string" ? body.status : "";
  const message = typeof body.message === "string" ? body.message : "";
  const amountDollars =
    typeof body.amount === "number"
      ? body.amount
      : typeof body.amount === "string"
        ? Number(body.amount)
        : NaN;

  // ── 3. Normalize status code ───────────────────────────────
  // Handles every shape Quiklie returns:
  //   - Integer:        1
  //   - Digit string:   "1"
  //   - Uppercase name: "SUCCESS" / "DECLINED" (they do this sometimes)
  // Falls back to the `status` string if statusCode is missing.
  const statusCode = parseQuiklieStatusCode(body.statusCode, status);
  if (statusCode === null) {
    console.warn("[Quiklie Notify] unparseable statusCode", {
      status,
      rawStatusCode: body.statusCode,
      transactionReferenceId,
    });
    // 200 so Quiklie doesn't retry indefinitely on a shape we can't read.
    return NextResponse.json({ ok: true, note: "unparseable status" });
  }

  // ── 4. Find the order ──────────────────────────────────────
  // ── TODO: REPLACE THIS BLOCK WITH YOUR DB LOOKUP ──
  //
  // Primary lookup: transactionReferenceId → orders.transactionRef
  // Fallback:        quikliePaymentId       → orders.quikliePaymentId
  //
  // Example with Drizzle ORM:
  //   let [order] = await db
  //     .select()
  //     .from(orders)
  //     .where(eq(orders.transactionRef, transactionReferenceId))
  //     .limit(1);
  //   if (!order && quikliePaymentId) {
  //     [order] = await db
  //       .select()
  //       .from(orders)
  //       .where(eq(orders.quikliePaymentId, quikliePaymentId))
  //       .limit(1);
  //   }
  //
  // Stub for the template:
  const order: {
    id: string;
    orderNumber: string;
    email: string;
    total: number;            // cents
    userId: string | null;
    paymentStatus: string;
    status: string;
  } | null = null;

  if (!order) {
    console.warn("[Quiklie Notify] order not found", {
      transactionReferenceId,
      quikliePaymentId,
    });
    // Return 200 so Quiklie doesn't retry indefinitely.
    return NextResponse.json({ ok: true, note: "order not found" });
  }

  // ── 5. Amount-match defense ────────────────────────────────
  // Blocks a leaked-API-key attacker from forging SUCCESS for an
  // arbitrary order without also guessing its exact total.
  if (statusCode === QUIKLIE_WEBHOOK_STATUS.SUCCESS) {
    if (!amountMatches(amountDollars, order.total)) {
      console.error(
        "[Quiklie Notify] amount mismatch — refusing to mark paid",
        {
          orderNumber: order.orderNumber,
          expectedDollars: order.total / 100,
          receivedDollars: amountDollars,
          quikliePaymentId,
        },
      );
      return NextResponse.json({ error: "Amount mismatch" }, { status: 400 });
    }
  }

  // ── 6. Replay guard ────────────────────────────────────────
  if (
    order.paymentStatus === "completed" ||
    order.status === "cancelled" ||
    order.paymentStatus === "refunded"
  ) {
    return NextResponse.json({ ok: true, note: "already processed" });
  }

  // ── 7. Apply the state transition ──────────────────────────
  if (statusCode === QUIKLIE_WEBHOOK_STATUS.SUCCESS) {
    // ── TODO: ATOMIC COMPLETION CLAIM ──
    // Use a conditional UPDATE so concurrent webhook + status-poll +
    // reconcile-cron callers don't all fire the side-effects below.
    // Example (Drizzle):
    //   const claimed = await db.update(orders)
    //     .set({ paymentStatus: "completed", status: "confirmed", ... })
    //     .where(and(
    //       eq(orders.id, order.id),
    //       inArray(orders.paymentStatus, ["unpaid", "pending"]),
    //     ))
    //     .returning({ id: orders.id });
    //   if (claimed.length === 0) return NextResponse.json({ ok: true, note: "concurrent completion" });

    // ── TODO: SIDE-EFFECTS ──
    // Fire your fulfillment push, confirmation email, analytics events,
    // affiliate commission, abandoned-cart conversion, etc. Each should
    // be fire-and-forget — never block the webhook response on them.
    // Quiklie expects a fast 200 or it'll retry.
    //
    // Examples:
    //   pushOrderToShipStation(order.id).catch(console.error);
    //   sendOrderConfirmationEmail({ ... }).catch(console.error);
    //   notifyAdminOfSale(order.id).catch(console.error);
  } else if (statusCode === QUIKLIE_WEBHOOK_STATUS.DECLINED) {
    // ── TODO: mark as failed ──
    //   await db.update(orders).set({
    //     paymentStatus: "failed",
    //     status: "cancelled",
    //     notes: `Quiklie declined: ${message}`,
    //   }).where(eq(orders.id, order.id));
  } else if (statusCode === QUIKLIE_WEBHOOK_STATUS.REFUNDED) {
    // ── TODO: mark as refunded ──
  } else if (statusCode === QUIKLIE_WEBHOOK_STATUS.CHARGEBACK) {
    // ── TODO: mark as chargeback + alert operator ──
    console.error(`[Quiklie Notify] CHARGEBACK on ${order.orderNumber}: ${message}`);
  } else {
    // Non-terminal status codes (2 = 3DS, 3 = OTP, 4 = pending, 7 = refund-failed).
    // Leave the order alone — log for observability.
    console.warn("[Quiklie Notify] non-terminal status", {
      orderNumber: order.orderNumber,
      status,
      statusCode,
    });
  }

  return NextResponse.json({ ok: true });
}
