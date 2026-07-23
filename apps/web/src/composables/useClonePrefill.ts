/**
 * useClonePrefill — turns a list row into a fresh DRAFT seed and navigates to
 * the matching create route. The one real bug to avoid: NEVER copy the document
 * number, id, status, payments, or issue-stamped fields. A clone is always a new
 * draft the user re-issues.
 *
 * Mechanism: strip → stash in the Pinia scratch store (survives the single
 * navigation, unlike route state on reload) → push the create route. The create
 * form calls `consumeClone(type)` on mount to read + clear the seed.
 */
import { useRouter } from "vue-router";
import { useClonePrefillStore, type ClonableType } from "@/stores/clonePrefill";
import type { LineItemComputed, LineItemInput } from "@/types/domain";

/** Fields that must NEVER survive a clone (identity, lifecycle, money-owed, stamps). */
const STRIP_KEYS = new Set<string>([
  "id",
  "version",
  "createdAt",
  "updatedAt",
  "createdBy",
  "status",
  // Document numbers (per type).
  "invoiceNumber",
  "quoteNumber",
  "proformaNumber",
  "creditNoteNumber",
  // Payments / balances.
  "payments",
  "amountPaidMinor",
  "amountDueMinor",
  // Issue / conversion stamps.
  "issuedAt",
  "finalizedAt",
  "scheduledSendDate",
  "convertedInvoiceId",
  "convertedFromQuoteId",
  "publicToken",
  "invoicedAt",
  "invoiceId",
  "fileId",
]);

export const toLineItemInputs = (items: LineItemComputed[] | undefined): LineItemInput[] => {
  if (!items || items.length === 0) return [];
  return items.map((li) => ({
    description: li.description,
    quantity: li.quantity,
    unitPriceMinor: li.unitPriceMinor,
    ...(li.discountRate !== undefined ? { discountRate: li.discountRate } : {}),
    ...(li.taxRate !== undefined ? { taxRate: li.taxRate } : {}),
  }));
};

export const buildCloneSeed = (row: Record<string, unknown>): Record<string, unknown> => {
  const seed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (STRIP_KEYS.has(k)) continue;
    seed[k] = v;
  }
  if (Array.isArray(row.lineItems)) {
    seed.lineItems = toLineItemInputs(row.lineItems as LineItemComputed[]);
  }
  return seed;
};

/** Map a clonable type to its create route name. */
const CREATE_ROUTE: Record<ClonableType, string> = {
  invoice: "invoice-create",
  quote: "quote-create",
  proforma: "proforma-create",
  "credit-note": "credit-note-create",
  contract: "contract-create",
  expense: "expense-create",
};

export const useClonePrefill = (): {
  cloneRow: (type: ClonableType, row: Record<string, unknown>) => void;
} => {
  const router = useRouter();
  const store = useClonePrefillStore();

  function cloneRow(type: ClonableType, row: Record<string, unknown>): void {
    store.set(type, buildCloneSeed(row));
    void router.push({ name: CREATE_ROUTE[type] });
  }

  return { cloneRow };
};

export const consumeClone = (type: ClonableType): Record<string, unknown> | null => {
  return useClonePrefillStore().consume(type);
};
