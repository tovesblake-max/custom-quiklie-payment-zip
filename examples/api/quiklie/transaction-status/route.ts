/**
 * Quiklie transaction status poll — TEMPLATE.
 *
 * Drop this at: app/api/quiklie/transaction-status/route.ts
 *
 * Used as the fallback when the customer's browser lands on /checkout/
 * callback BEFORE Quiklie's webhook has updated the order. Polls
 * Quiklie's /api/v1/transaction-status/{id} endpoint to get the
 * authoritative state.
 *
 * Auth-gate this to the calling user so one customer can't read
 * another's order by guessing the qkpaymentId.
 */
import { NextResponse } from "next/server";
import { getTransactionStatus } from "custom-quiklie-payment-zip";

export async function POST(request: Request) {
  // ── TODO: AUTH ──
  // const user = await requireAuth();

  const { paymentId } = (await request.json()) as { paymentId?: string };
  if (!paymentId || typeof paymentId !== "string") {
    return NextResponse.json({ error: "paymentId required" }, { status: 400 });
  }

  // ── TODO: CONFIRM THIS PAYMENT BELONGS TO THE CALLING USER ──
  // Look up the order by its quikliePaymentId and compare userId.
  // Skip this check at your peril — it's the only thing preventing
  // one customer from reading another's order status.

  const result = await getTransactionStatus(paymentId);
  if (!result.ok || !result.data) {
    return NextResponse.json(
      { error: "Status lookup failed" },
      { status: 502 },
    );
  }

  return NextResponse.json({
    paymentId: result.data.quickleePaymentId,
    status: result.data.status,
    statusCode: result.data.statusCode,
    message: result.data.quikleeMessage,
    amount: result.data.amount,
    currency: result.data.currency,
  });
}
