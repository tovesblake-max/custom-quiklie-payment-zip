/**
 * Customer-facing notice shown ABOVE the "Pay with Card" button on the
 * checkout page. Tells the customer three things they need to know
 * before clicking pay so first-attempt failure rates drop:
 *
 *   1. Charges show as "<descriptor>" on their statement (not your
 *      brand — Quiklie routes through an international acquirer)
 *   2. They'll be redirected to Quiklie's hosted page, then bounced
 *      back here on success
 *   3. International transactions must be enabled on their card (the
 *      #1 decline cause per Quiklie's dev team)
 *
 * Usage:
 *   <QuiklieRedirectNotice descriptor="DTF HORIZONTRV" />
 *
 * The descriptor prop should match exactly what you pass to
 * processPaymentHPP({ descriptor: ... }) — same string. That way the
 * customer sees the same name on the notice and on their statement.
 */
"use client";

interface Props {
  descriptor: string;
  supportEmail?: string;
}

export default function QuiklieRedirectNotice({
  descriptor,
  supportEmail = "support@example.com",
}: Props) {
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-5 flex gap-2.5">
      <svg
        className="w-4 h-4 text-amber-700 flex-shrink-0 mt-0.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
      <div className="min-w-0 space-y-2">
        <p className="text-[13px] font-semibold text-amber-900 leading-snug">
          Charges will appear as{" "}
          <span className="text-red-700 font-bold">{descriptor}</span>
        </p>
        <p className="text-[12px] text-amber-800 leading-snug">
          You will be securely redirected to our verified international
          payment gateway. <strong>Please ensure international payments are
          enabled on your card</strong> to avoid a transaction failure — this
          is the most common reason cards get declined here. Once payment is
          completed, you will be redirected back here.
        </p>
        <p className="text-[12px] text-amber-800 leading-snug">
          <span className="text-red-700 font-bold">
            Visa, Mastercard, and American Express accepted.
          </span>
        </p>
        <p className="text-[11px] text-amber-700/90 leading-snug">
          Questions? Email{" "}
          <a href={`mailto:${supportEmail}`} className="underline font-medium">
            {supportEmail}
          </a>{" "}
          before disputing if anything looks unfamiliar on your statement.
        </p>
      </div>
    </div>
  );
}
