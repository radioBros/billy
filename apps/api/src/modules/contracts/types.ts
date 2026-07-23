import type { BaseDoc } from "@billy/types";

/**
 * Contract entity. Extends BaseDoc (adds `version` + `deletedAt`). Covers the
 * core lifecycle fields; related entities are referenced by string id
 * only (clientId, relatedRecurringProfileId, fileId). Money is integer minor
 * units in `currency` — the field is `valueMinor`.
 */

/** Contract lifecycle statuses. `expiring`/`expired` are scanner-derived. */
export type ContractStatus =
  | "draft"
  | "active"
  | "expiring"
  | "expired"
  | "terminated"
  | "renewed"
  | "archived";

/** Contract type taxonomy. */
export type ContractType =
  | "development"
  | "maintenance"
  | "hosting"
  | "support"
  | "consulting"
  | "service_agreement"
  | "retainer"
  | "other";

export interface Contract extends BaseDoc {
  /** Owning client — referenced by id (clients module). */
  clientId: string;
  projectId?: string | null;
  title: string;
  type: ContractType;
  status: ContractStatus;
  /** `YYYY-MM-DD` in business timezone. */
  startDate: string;
  /** `YYYY-MM-DD`; null/absent for open-ended contracts. */
  endDate?: string | null;
  /** Contract value, integer minor units in `currency` (financial field). */
  valueMinor?: number | null;
  /** ISO 4217. Present when `valueMinor` is set. */
  currency?: string | null;
  /** Linked recurring-billing profile — referenced by id (recurring-billing module). */
  relatedRecurringProfileId?: string | null;
  /** Signed-PDF file — referenced by id (files-storage module). */
  fileId?: string | null;
  terms?: string | null;
  notes?: string | null;
  createdBy?: string | null;
}
