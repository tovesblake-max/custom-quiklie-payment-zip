/**
 * Order result poll endpoint — TEMPLATE.
 *
 * Drop this at: app/api/checkout/result/route.ts
 *
 * Called by the /checkout/callback page to confirm a payment. Reads
 * the order's current status from your DB; if still pending, falls
 * back to polling Quiklie's transaction-status API for the
 * authoritative state.
 *
 * Auth-gate to the calling user so one customer can't read another's
 * order by guessing order numbers.
 */
import { NextResponse } from "next/server";
import { getTransactionStatus, QUIKLIE_STATUS } from "custom-quiklie-payment-zip";

export async function POST(request: Request) {
  try {
    // ── TODO: AUTH ──
    // const user = await requireAuth();

    const { orderNumber } = (await request.json()) as { orderNumber?: string };
    if (!orderNumber) {
      return NextResponse.json({ error: "orderNumber required" }, { status: 400 });
    }

    // ── TODO: LOOK UP THE ORDER FOR THIS USER ──
    // Required fields: id, orderNumber, paymentStatus, paymentGateway,
    // total, quikliePaymentId, transactionRef, email, items
    //
    // Stub for the template:
    const order: {
      id: string;
      orderNumber: string;
      paymentStatus: string;
      paymentGateway: string;
      total: number;
      quikliePaymentId: string | null;
      transactionRef: string | null;
      email: string;
    } | null = null;

    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    // ── TODO: load line items for the response (so the success page
    //          can render an itemized summary) ──
    const items: Array<Record<string, unknown>> = [];

    // Happy path — webhook already confirmed.
    if (order.paymentStatus === "completed") {
      return NextResponse.json({
        status: "completed",
        orderNumber,
        order: { total: order.total, email: order.email },
        items,
      });
    }

    // Fallback — webhook may not have arrived yet. Poll Quiklie's
    // transaction-status API for the authoritative state.
    if (
      order.paymentGateway === "quiklie" &&
      (order.quikliePaymentId || order.transactionRef)
    ) {
      const lookupId = order.quikliePaymentId || order.transactionRef!;
      const poll = await getTransactionStatus(lookupId);
      if (poll.ok && poll.data) {
        const code = String(poll.data.statusCode);
        if (code === "1" || poll.data.status?.toUpperCase() === "SUCCESS") {
          // ── TODO: UPDATE THE ORDER ──
          // Conditional UPDATE so we don't double-flip if the webhook
          // landed concurrently. Example (Drizzle):
          //   await db.update(orders)
          //     .set({ paymentStatus: "completed", status: "confirmed" })
          //     .where(and(
          //       eq(orders.id, order.id),
          //       inArray(orders.paymentStatus, ["unpaid", "pending"]),
          //     ));
          return NextResponse.json({
            status: "completed",
            orderNumber,
            order: { total: order.total, email: order.email },
            items,
          });
        }
        if (code === String(QUIKLIE_STATUS.DECLINED)) {
          return NextResponse.json({
            status: "failed",
            msg: poll.data.quikleeMessage || "Payment was declined",
          });
        }
      }
    }

    // Still pending — callback hasn't arrived. Client retries.
    return NextResponse.json({
      status: order.paymentStatus === "failed" ? "failed" : "pending",
      msg: "Payment still processing",
    });
  } catch (error) {
    console.error("[Checkout Result]", error);
    return NextResponse.json({ error: "Failed to verify payment" }, { status: 500 });
  }
}
