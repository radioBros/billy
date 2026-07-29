import type { BaseDoc, ListWhitelist } from "@billy/types";

/**
 * Project entity — an account-scoped grouping that any domain document can
 * optionally be assigned to (invoices, quotes, expenses, time entries, …). A
 * plain, account-isolated entity via BaseRepository. `version` + `deletedAt`
 * come from BaseDoc; `accountId` is stamped by the repository.
 */
export const PROJECT_STATUSES = ["active", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface Project extends BaseDoc {
  name: string;
  /** Optional client this project belongs to (account-scoped client id). */
  clientId?: string | null;
  status: ProjectStatus;
  /** Optional free-text description. */
  description?: string | null;
  /** Optional hex colour for UI chips. */
  color?: string | null;
}

/** Whitelisted list fields (index-backed). */
export const PROJECT_LIST_WHITELIST: ListWhitelist = {
  sortable: ["createdAt", "updatedAt", "name", "status"],
  filterable: ["status", "clientId"],
  searchable: ["name", "description"],
};
