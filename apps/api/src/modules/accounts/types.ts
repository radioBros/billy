import type { BaseDoc, ListWhitelist } from "@billy/types";

/**
 * Account entity — a tenant. Each account is one company using the stack; all
 * domain data is bound to exactly one account via its `accountId`. Accounts are
 * a GLOBAL collection (not account-scoped themselves) — only the sysadmin manages
 * them. `version` + `deletedAt` come from BaseDoc.
 */
export const ACCOUNT_STATUSES = ["active", "suspended"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export interface Account extends BaseDoc {
  /** Human-facing company/account name. */
  name: string;
  /** URL-safe short identifier (unique, lowercase). Handy for display/routing. */
  slug: string;
  status: AccountStatus;
  /** Optional free-text note for the sysadmin. */
  note?: string | null;
}

/** Whitelisted list fields (index-backed). */
export const ACCOUNT_LIST_WHITELIST: ListWhitelist = {
  sortable: ["createdAt", "updatedAt", "name", "slug", "status"],
  filterable: ["status"],
  searchable: ["name", "slug"],
};
