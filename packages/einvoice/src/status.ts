/** billy-side e-invoice lifecycle, derived from PASSO's submission state + receipts. */
export const EINVOICE_STATUSES = [
  "not_sent",
  "blocked",
  "queued",
  "transmitted",
  "awaiting_delivery",
  "delivered",
  "undelivered_attested",
  "accepted_by_pa",
  "rejected_by_pa",
  "rejected",
  "failed",
] as const;
export type EInvoiceStatus = (typeof EINVOICE_STATUSES)[number];

/** PASSO submission states (GET /invoices/:id → status). */
const PASSO_TO_BILLY: Record<string, EInvoiceStatus> = {
  queued: "queued",
  transforming: "queued",
  generating: "queued",
  signing: "queued",
  transmitting: "queued",
  transmitted: "transmitted",
  awaiting_delivery: "awaiting_delivery",
  delivered: "delivered",
  undelivered_attested: "undelivered_attested",
  accepted_by_pa: "accepted_by_pa",
  rejected_by_pa: "rejected_by_pa",
  rejected: "rejected",
  failed: "failed",
};

export const fromPassoState = (state: string): EInvoiceStatus => PASSO_TO_BILLY[state] ?? "queued";

/** The invoice is legally issued once SdI accepted it (everything except not-sent / NS / failed in flight). */
const ISSUED: ReadonlySet<EInvoiceStatus> = new Set([
  "awaiting_delivery",
  "delivered",
  "undelivered_attested",
  "accepted_by_pa",
  "rejected_by_pa",
]);
export const isLegallyIssued = (s: EInvoiceStatus): boolean => ISSUED.has(s);

/** No further SdI movement expected that billy must act on. */
const FINAL: ReadonlySet<EInvoiceStatus> = new Set([
  "delivered",
  "undelivered_attested",
  "accepted_by_pa",
  "rejected_by_pa",
  "rejected",
  "failed",
]);
export const isFinalStatus = (s: EInvoiceStatus): boolean => FINAL.has(s);

/** In flight with PASSO or SdI (block a second submit; keep syncing). */
export const isInFlight = (s: EInvoiceStatus): boolean =>
  s === "queued" || s === "transmitted" || s === "awaiting_delivery";

/** Status after which billy can submit (again). */
export const canSubmit = (s: EInvoiceStatus): boolean => s === "not_sent" || s === "blocked";
/** `failed` is retried on the SAME submission (same ProgressivoInvio) via PASSO /retry. */
export const canRetry = (s: EInvoiceStatus): boolean => s === "failed";

/**
 * Polling cadence per status (seconds between syncs; null = stop).
 * MC (`awaiting_delivery`) is final for the user but SdI may still send RC, so poll slowly
 * and give up after `MC_POLL_DAYS`.
 */
export const MC_POLL_DAYS = 15;
export const MAX_POLL_DAYS = 30;
export const pollIntervalSec = (s: EInvoiceStatus, baseSec: number): number | null => {
  switch (s) {
    case "queued":
    case "transmitted":
      return baseSec;
    case "awaiting_delivery":
      return 24 * 3600;
    case "delivered":
    case "undelivered_attested":
    case "accepted_by_pa":
    case "rejected_by_pa":
    case "rejected":
    case "failed":
      return null;
    default:
      return null;
  }
};
