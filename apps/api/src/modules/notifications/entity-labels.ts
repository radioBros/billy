import type { Db, Document } from "mongodb";
import type { Logger } from "@billy/shared";
import { INVOICES_COLLECTION } from "@/modules/invoices/repository.js";
import { QUOTES_COLLECTION } from "@/modules/quotes/repository.js";
import { PROFORMAS_COLLECTION } from "@/modules/proforma/repository.js";
import { CREDIT_NOTES_COLLECTION } from "@/modules/credit-notes/repository.js";
import { CLIENTS_COLLECTION } from "@/modules/clients/repository.js";
import { CONTRACTS_COLLECTION } from "@/modules/contracts/repository.js";
import { EXPENSES_COLLECTION } from "@/modules/expenses/repository.js";
import { PROJECTS_COLLECTION } from "@/modules/projects/repository.js";
import { SUBSCRIPTIONS_COLLECTION } from "@/modules/subscriptions/repository.js";
import { RECURRING_PROFILES_COLLECTION } from "@/modules/recurring-billing/repository.js";
import { TIME_ENTRIES_COLLECTION } from "@/modules/time-tracking/repository.js";

/**
 * Human label for a notification's entity ("INV-2026-0001", "Acme Srl", …).
 * `draft` marks an unnumbered document (label "Draft") so the client can
 * translate it. An empty label means "unknown" — never fall back to the raw id.
 */
export interface EntityLabel {
  label: string;
  draft?: boolean;
}

/** Port the NotificationService resolves entity labels through (optional dep). */
export interface EntityLabelResolver {
  labelFor(accountId: string, entityType: string, entityId: string): Promise<EntityLabel>;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Numbered documents: the number once assigned, else "Draft". */
const numbered = (field: string) => (doc: Document): EntityLabel => {
  const n = str(doc[field]);
  return n ? { label: n } : { label: "Draft", draft: true };
};

interface LabelSource {
  collection: string;
  label: (doc: Document) => EntityLabel;
  /** Fallback to the linked client's displayName when the doc has no own label. */
  clientFallback?: boolean;
}

/** entityType (exactly as the modules emit it) → where + how to read its label. */
const SOURCES: Readonly<Record<string, LabelSource>> = {
  invoice: { collection: INVOICES_COLLECTION, label: numbered("invoiceNumber") },
  quote: { collection: QUOTES_COLLECTION, label: numbered("quoteNumber") },
  proforma: { collection: PROFORMAS_COLLECTION, label: numbered("proformaNumber") },
  creditNote: { collection: CREDIT_NOTES_COLLECTION, label: numbered("creditNoteNumber") },
  client: { collection: CLIENTS_COLLECTION, label: (d) => ({ label: str(d.displayName) }) },
  contract: { collection: CONTRACTS_COLLECTION, label: (d) => ({ label: str(d.title) }) },
  expense: { collection: EXPENSES_COLLECTION, label: (d) => ({ label: str(d.vendor) || str(d.description) }) },
  project: { collection: PROJECTS_COLLECTION, label: (d) => ({ label: str(d.name) }) },
  subscription: { collection: SUBSCRIPTIONS_COLLECTION, label: (d) => ({ label: str(d.name) }) },
  timeEntry: { collection: TIME_ENTRIES_COLLECTION, label: (d) => ({ label: str(d.description) }) },
  recurring_profile: {
    collection: RECURRING_PROFILES_COLLECTION,
    label: (d) => ({ label: str(d.subject) }),
    clientFallback: true,
  },
};

/**
 * Mongo-backed resolver. Reads ONLY within the event's account (`accountId`
 * filter — no cross-tenant reads). Never throws: any failure → empty label.
 */
export const createEntityLabelResolver = (db: Db, logger?: Logger): EntityLabelResolver => {
  const findInAccount = async (collection: string, id: string, accountId: string): Promise<Document | null> => {
    return db.collection(collection).findOne({ id, accountId }, { projection: { _id: 0 } });
  };

  return {
    async labelFor(accountId, entityType, entityId) {
      const source = SOURCES[entityType];
      if (!source || !entityId || !accountId) return { label: "" };
      try {
        const doc = await findInAccount(source.collection, entityId, accountId);
        if (!doc) return { label: "" };
        const own = source.label(doc);
        if (own.label || !source.clientFallback) return own;
        const clientId = str(doc.clientId);
        if (!clientId) return own;
        const client = await findInAccount(CLIENTS_COLLECTION, clientId, accountId);
        return { label: client ? str(client.displayName) : "" };
      } catch (err) {
        logger?.warn({ err, entityType }, "notification.entity_label_failed");
        return { label: "" };
      }
    },
  };
};
