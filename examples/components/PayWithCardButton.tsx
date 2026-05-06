/**
 * Customer-facing "Pay with Card" button. Posts the cart to your
 * Quiklie HPP route, then full-page-redirects the customer to Quiklie's
 * hosted card-entry page. PAN + CVV never touch your origin → PCI SAQ-A.
 *
 * Usage:
 *   <PayWithCardButton
 *     items={cartItems}
 *     shippingAddress={addr}
 *     totalDollars={totalDollars}
 *     endpoint="/api/checkout/quiklie-hpp"
 *   />
 *
 * Pair with <QuiklieRedirectNotice /> directly above — together they
 * make up the complete Quiklie HPP card-payment surface.
 */
"use client";

import { useRef, useState } from "react";

export interface CartItem {
  productId: string;
  productName: string;
  variantSku: string;
  price: number; // cents
  quantity: number;
  slug: string;
}

export interface ShippingAddress {
  firstName: string;
  lastName: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
}

interface Props {
  items: CartItem[];
  shippingAddress: ShippingAddress;
  totalDollars: number;
  /** Where to POST. Defaults to /api/checkout/quiklie-hpp. */
  endpoint?: string;
}

export default function PayWithCardButton({
  items,
  shippingAddress,
  totalDollars,
  endpoint = "/api/checkout/quiklie-hpp",
}: Props) {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-attempt idempotency key — reused across double-clicks so the
  // server (and Quiklie) dedupe.
  const idempotencyKeyRef = useRef<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : Array.from({ length: 32 }, () =>
              Math.floor(Math.random() * 16).toString(16),
            ).join("");
    }
    setProcessing(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: idempotencyKeyRef.current,
          items,
          shippingAddress,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        // Non-409 responses clear the key so the next attempt mints a fresh one.
        if (res.status !== 409) idempotencyKeyRef.current = null;
        setError(data.error || "Payment failed.");
        setProcessing(false);
        return;
      }
      if (data.status === "redirect" && data.redirectUrl) {
        // Intentionally NOT clearing the cart here — if the redirect
        // never resolves (popup blocker, customer hits Back) we want
        // the cart still in localStorage for retry. /checkout/callback
        // is responsible for clearing on confirmed success.
        window.location.href = data.redirectUrl;
        return;
      }
      setError("Could not start secure payment session. Please try again.");
      setProcessing(false);
    } catch {
      setError("Network error. Please try again.");
      setProcessing(false);
    }
  };

  return (
    <>
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-3 text-sm text-red-800">
          {error}
        </div>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={processing || items.length === 0}
        className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {processing ? (
          <>
            <svg
              className="w-4 h-4 animate-spin"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M12 2v4m0 12v4m9-10h-4M7 12H3m13.314-7.314l-2.829 2.829M7.515 16.485l-2.829 2.829m0-15.314l2.829 2.829m9.142 9.142l2.829 2.829" />
            </svg>
            Redirecting to secure payment...
          </>
        ) : (
          <>
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
            Pay ${totalDollars.toFixed(2)} via Card
          </>
        )}
      </button>
      <p className="text-[10px] text-gray-500 text-center mt-2">
        256-bit encrypted · Card data never touches our servers
      </p>
    </>
  );
}
