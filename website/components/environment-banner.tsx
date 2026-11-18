import { currentEnvironment } from "@/lib/environment";

// Server components: the environment comes from server configuration, so the
// browser cannot switch it. LIVE renders nothing.

export function EnvironmentBanner() {
  if (currentEnvironment() !== "test") return null;
  return (
    <div className="test-mode-banner" role="status" data-environment="test">
      <strong>TEST MODE</strong>
      <span>
        This is the RastasperiQ test site. Every account, order and payment here is a test record. No real money is
        charged.
      </span>
    </div>
  );
}

export function TestPaymentNotice() {
  if (currentEnvironment() !== "test") return null;
  return (
    <p className="test-payment-notice" role="note" data-environment="test">
      <strong>TEST MODE payment.</strong> Use a Yoco test card. Real cards are not charged on this site.
    </p>
  );
}
