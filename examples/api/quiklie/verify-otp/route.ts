/**
 * Quiklie OTP verification — TEMPLATE.
 *
 * Drop this at: app/api/quiklie/verify-otp/route.ts
 *
 * When a customer's transaction returns statusCode = 3 (OTP_REQUIRED),
 * collect the OTP they received and POST it here. We forward to
 * Quiklie's /api/v1/verify-otp endpoint and update the order.
 *
 * Most modern card flows go through 3DS instead of OTP — you may not
 * see this code path in practice. Keep it wired anyway for completeness.
 */
import { NextResponse } from "next/server";
import { verifyOTP } from "custom-quiklie-payment-zip";
import { z } from "zod";

const schema = z.object({
  // Quiklie's qkpaymentId returned with the original process-payment
  // response. Required for the verify call.
  transactionId: z.string().min(1),
  // The 4-8 digit OTP the customer received via SMS / email / app.
  otp: z.string().regex(/^\d{4,8}$/, "OTP must be 4-8 digits"),
});

export async function POST(request: Request) {
  // ── TODO: AUTH (require the customer who placed the order) ──
  // const user = await requireAuth();

  let payload: z.infer<typeof schema>;
  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    payload = parsed.data;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const result = await verifyOTP(payload.transactionId, payload.otp);
  if (!result.ok || !result.data) {
    return NextResponse.json(
      { error: "OTP verification failed", details: result.raw?.slice(0, 200) },
      { status: 502 },
    );
  }

  if (result.data.approved) {
    // ── TODO: mark the order as completed (the webhook may also fire) ──
    return NextResponse.json({
      ok: true,
      message: result.data.message || "Payment approved",
    });
  }

  return NextResponse.json(
    {
      ok: false,
      error: result.data.message || "OTP rejected",
    },
    { status: 400 },
  );
}
