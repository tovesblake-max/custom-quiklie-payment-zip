/**
 * /checkout/callback page — TEMPLATE.
 *
 * Drop this at: app/checkout/callback/page.tsx (with "use client").
 *
 * The page Quiklie redirects the customer to AFTER they complete
 * payment on the hosted page. Reads the order's status from your
 * server and renders success or a friendly failure explanation.
 *
 * Critical detail: this page MUST poll for status, not single-shot
 * fetch. The Quiklie webhook and the customer's browser-redirect race
 * each other — sub-second window where the order is still "unpaid" in
 * your DB even though the gateway charged the card. A single fetch
 * during that window would render failure → customer thinks the order
 * didn't go through → places a SECOND order. We've watched this happen
 * in production with three separate customers; the polling is what
 * stopped it.
 */
"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import {
  translateQuiklieDecline,
  type DeclineExplanation,
} from "custom-quiklie-payment-zip";

type Status = "loading" | "success" | "failed";

export default function CheckoutCallbackPage() {
  const searchParams = useSearchParams();
  const orderNumber = searchParams.get("order_number");
  const [status, setStatus] = useState<Status>("loading");
  const [declineExplanation, setDeclineExplanation] =
    useState<DeclineExplanation | null>(null);

  useEffect(() => {
    if (!orderNumber) {
      setStatus("failed");
      return;
    }

    // Polling retry: up to 8 attempts at 1.5s spacing (~12s total).
    // Closes the webhook race window. See the file header for context.
    let attempts = 0;
    const MAX_ATTEMPTS = 8;
    const RETRY_DELAY_MS = 1500;

    async function loadOrder() {
      try {
        attempts += 1;
        const res = await fetch("/api/checkout/result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderNumber }),
        });
        const data = await res.json();

        if (data.status === "completed") {
          setStatus("success");
          // ── TODO: clear the cart, fire purchase analytics event, etc. ──
          return;
        }

        if (data.status === "pending" && attempts < MAX_ATTEMPTS) {
          setTimeout(loadOrder, RETRY_DELAY_MS);
          return;
        }

        if (data.status === "failed") {
          setDeclineExplanation(translateQuiklieDecline(data.msg));
          setStatus("failed");
          return;
        }

        // Exhausted retries on pending — show the soft "still verifying"
        // message that EXPLICITLY tells the customer not to pay again.
        // This is the message that prevents the duplicate-order behavior.
        setDeclineExplanation({
          headline: "Still verifying your payment",
          detail:
            "Your payment is taking longer than usual to confirm. If you completed the payment on the previous page, please DO NOT pay again — your card has likely been charged. Refresh this page in 30 seconds, or check your email for an order confirmation. If nothing arrives in 5 minutes, please contact support.",
          cta: "Refresh in 30 seconds",
        });
        setStatus("failed");
      } catch {
        if (attempts < MAX_ATTEMPTS) {
          setTimeout(loadOrder, RETRY_DELAY_MS);
          return;
        }
        setDeclineExplanation(translateQuiklieDecline(null));
        setStatus("failed");
      }
    }

    loadOrder();
  }, [orderNumber]);

  if (status === "loading") {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 mx-auto mb-4 animate-spin border-4 border-blue-600 border-t-transparent rounded-full" />
          <p className="text-gray-500">Verifying your payment...</p>
        </div>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div className="min-h-[60vh] flex items-center justify-center px-4">
        <div className="max-w-md w-full text-center">
          <h1 className="text-3xl font-serif mb-2">Thank you for your order!</h1>
          {orderNumber && (
            <p className="text-sm text-gray-500">
              Order: <span className="font-mono">{orderNumber}</span>
            </p>
          )}
          {/* ── TODO: render itemized order summary, what-happens-next, etc. ── */}
        </div>
      </div>
    );
  }

  const explanation = declineExplanation ?? translateQuiklieDecline(null);
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="max-w-lg w-full text-center">
        <h1 className="text-3xl font-serif mb-2">{explanation.headline}</h1>
        <p className="text-gray-600 mb-2 leading-relaxed">{explanation.detail}</p>
        <p className="text-sm text-gray-500 mb-8">No charge was made on your account.</p>
        <a
          href="/checkout"
          className="inline-block px-5 py-3 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700"
        >
          {explanation.cta || "Try Again"}
        </a>
      </div>
    </div>
  );
}
