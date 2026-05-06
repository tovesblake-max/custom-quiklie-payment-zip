/**
 * Admin-initiated Quiklie refund — TEMPLATE.
 *
 * Drop this at: app/api/admin/refund/route.ts
 *
 * Calls Quiklie's POST /api/v1/refund endpoint with the order's stored
 * qkpaymentId. Supports partial refunds (pass `amount`) and full
 * refunds (omit `amount`, defaults to remaining balance).
 *
 * Atomic-claim safety:
 *   1. Flip paymentStatus → 'refunding' BEFORE calling the gateway.
 *      A second concurrent click finds the row already locked and 409s.
 *   2. Track cumulative refunds in a separate column so multiple partial
 *      refunds can never exceed the original total.
 *   3. On gateway failure, revert the claim so the operator can retry.
 */
import { NextResponse } from "next/server";
import { processRefund, parseQuiklieStatusCode, QUIKLIE_WEBHOOK_STATUS } from "custom-quiklie-payment-zip";

export async function POST(request: Request) {
  // ── TODO: ADMIN AUTH ──
  // Replace with your admin-only auth check.
  //   await requireAdmin();

  const { orderId, amount, note } = (await request.json()) as {
    orderId?: string;
    amount?: number;       // optional, dollars (e.g. 49.99). Omit for full.
    note?: string;
  };

  if (!orderId || typeof orderId !== "string") {
    return NextResponse.json({ error: "orderId required" }, { status: 400 });
  }

  // ── TODO: LOOK UP THE ORDER ──
  // Required fields:
  //   - quikliePaymentId  (the qkpaymentId returned by Quiklie at charge time)
  //   - total             (cents)
  //   - refundedAmountCents (cents already refunded — for partials)
  //   - paymentStatus     (must be 'completed' or 'pending' to refund)
  //
  // Stub for the template:
  const order: {
    id: string;
    orderNumber: string;
    quikliePaymentId: string | null;
    total: number;                  // cents
    refundedAmountCents: number;    // cents
    paymentStatus: string;
  } | null = null;

  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }
  if (!order.quikliePaymentId) {
    return NextResponse.json(
      { error: "Order has no Quiklie payment ID — cannot refund via API" },
      { status: 400 },
    );
  }

  // Compute refund amount in cents.
  const remainingCents = order.total - (order.refundedAmountCents ?? 0);
  if (remainingCents <= 0) {
    return NextResponse.json(
      { error: "Order is fully refunded" },
      { status: 400 },
    );
  }
  let refundCents: number;
  if (amount === undefined || amount === null) {
    refundCents = remainingCents;
  } else if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
  } else {
    refundCents = Math.round(amount * 100);
    if (refundCents > remainingCents) {
      return NextResponse.json(
        {
          error: `Refund $${(refundCents / 100).toFixed(2)} exceeds refundable balance $${(remainingCents / 100).toFixed(2)}`,
        },
        { status: 400 },
      );
    }
  }
  const refundDollars = refundCents / 100;

  // ── TODO: ATOMIC CLAIM ──
  // const claimed = await db.update(orders)
  //   .set({ paymentStatus: "refunding", updatedAt: new Date() })
  //   .where(and(
  //     eq(orders.id, orderId),
  //     inArray(orders.paymentStatus, ["completed", "pending"]),
  //     eq(orders.refundedAmountCents, order.refundedAmountCents),
  //   ))
  //   .returning({ id: orders.id });
  // if (claimed.length === 0) {
  //   return NextResponse.json(
  //     { error: "Refund already in progress, or order state changed — refresh and try again." },
  //     { status: 409 },
  //   );
  // }

  // Call Quiklie. Code 6 = REFUNDED (success). Anything else (including
  // code 7 = REFUND_FAILED) is treated as a refund failure.
  const refundResult = await processRefund({
    transactionId: order.quikliePaymentId,
    amountDollars: refundDollars,
    currencyCode: "USD",
    reason: note || undefined,
  });

  let gatewayError: string | null = null;
  if (!refundResult.ok || !refundResult.data) {
    gatewayError =
      (refundResult.data as { message?: string } | null)?.message ||
      refundResult.raw?.slice(0, 200) ||
      "Quiklie refund request failed";
  } else {
    const code = parseQuiklieStatusCode(
      refundResult.data.statusCode,
      refundResult.data.status,
    );
    if (code !== QUIKLIE_WEBHOOK_STATUS.REFUNDED) {
      gatewayError =
        refundResult.data.message ||
        `Quiklie returned status ${refundResult.data.status || refundResult.data.statusCode}`;
    }
  }

  if (gatewayError) {
    // ── TODO: REVERT THE CLAIM ──
    // await db.update(orders).set({ paymentStatus: order.paymentStatus }).where(eq(orders.id, orderId));
    return NextResponse.json({ error: gatewayError }, { status: 502 });
  }

  // ── TODO: BUMP CUMULATIVE COUNTER + APPEND AUDIT NOTE ──
  // const newCumulative = (order.refundedAmountCents ?? 0) + refundCents;
  // const refundedFully = newCumulative >= order.total;
  // await db.update(orders).set({
  //   status: refundedFully ? "refunded" : order.status,
  //   paymentStatus: refundedFully ? "refunded" : "completed",
  //   refundedAmountCents: sql`${orders.refundedAmountCents} + ${refundCents}`,
  //   notes: sql`${orders.notes} || ${"\n" + auditLine}`,
  // }).where(eq(orders.id, orderId));

  return NextResponse.json({
    message: `Refund of $${refundDollars.toFixed(2)} issued`,
    refundedThisCall: refundDollars,
  });
}
