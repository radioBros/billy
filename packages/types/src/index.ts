/**
 * Canonical shared contracts — the single source of truth for the API response
 * envelope, the error-code registry, and the list-query grammar.
 *
 * New error codes are APPENDED here, never invented ad-hoc in a module.
 */

// ── Background-jobs queue contract ──────────────────────────────────────────
export * from "./queues.js";

// ── Error-code registry (SNAKE_UPPER) ────────────────────────────────────────

export const ERROR_CODES = [
  // Auth / access
  "UNAUTHENTICATED",
  "INVALID_CREDENTIALS",
  "SESSION_EXPIRED",
  "SESSION_REVOKED",
  "TWO_FACTOR_REQUIRED",
  "TWO_FACTOR_INVALID",
  "FORBIDDEN",
  "CAPABILITY_DENIED",
  "RATE_LIMITED",
  // Validation
  "VALIDATION_FAILED",
  "INVALID_STATE_TRANSITION",
  "CURRENCY_MISMATCH",
  "PAYMENT_EXCEEDS_TOTAL",
  "DATE_RANGE_INVALID",
  "DUPLICATE_VALUE",
  "UNSUPPORTED_FILE_TYPE",
  "FILE_TOO_LARGE",
  // Concurrency / integrity
  "VERSION_CONFLICT",
  "IDEMPOTENCY_REPLAY",
  "INVOICE_ALREADY_FINALIZED",
  "INVOICE_ALREADY_PAID",
  "QUOTE_ALREADY_CONVERTED",
  "RESOURCE_ARCHIVED",
  "OCCURRENCE_ALREADY_GENERATED",
  // Not found
  "RESOURCE_NOT_FOUND",
  // Business rules
  "INVOICE_NOT_EDITABLE",
  "TIME_ENTRY_ALREADY_BILLED",
  "EXPENSE_ALREADY_INVOICED",
  "RECURRING_PROFILE_INACTIVE",
  "SUBSCRIPTION_PAYMENT_NOT_DUE",
  "TIMER_ALREADY_RUNNING",
  // System
  "INTERNAL_ERROR",
  "STORAGE_UNAVAILABLE",
  "EMAIL_DELIVERY_FAILED",
  "PDF_GENERATION_FAILED",
  "QUEUE_UNAVAILABLE",
  "DEPENDENCY_UNAVAILABLE",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Canonical HTTP status for each error code. `satisfies` makes this exhaustive:
 * adding an `ErrorCode` without a status here is a compile error. Statuses stay
 * within the declared set (+ 503 for system-unavailable, under "System (500/503)").
 */
export const ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  SESSION_EXPIRED: 401,
  SESSION_REVOKED: 401,
  TWO_FACTOR_REQUIRED: 401,
  TWO_FACTOR_INVALID: 401,
  FORBIDDEN: 403,
  CAPABILITY_DENIED: 403,
  RATE_LIMITED: 429,
  VALIDATION_FAILED: 422,
  INVALID_STATE_TRANSITION: 422,
  CURRENCY_MISMATCH: 422,
  PAYMENT_EXCEEDS_TOTAL: 422,
  DATE_RANGE_INVALID: 422,
  DUPLICATE_VALUE: 422,
  UNSUPPORTED_FILE_TYPE: 422,
  FILE_TOO_LARGE: 422,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_REPLAY: 409,
  INVOICE_ALREADY_FINALIZED: 409,
  INVOICE_ALREADY_PAID: 409,
  QUOTE_ALREADY_CONVERTED: 409,
  RESOURCE_ARCHIVED: 409,
  OCCURRENCE_ALREADY_GENERATED: 409,
  RESOURCE_NOT_FOUND: 404,
  INVOICE_NOT_EDITABLE: 422,
  TIME_ENTRY_ALREADY_BILLED: 422,
  EXPENSE_ALREADY_INVOICED: 422,
  RECURRING_PROFILE_INACTIVE: 422,
  SUBSCRIPTION_PAYMENT_NOT_DUE: 422,
  TIMER_ALREADY_RUNNING: 422,
  INTERNAL_ERROR: 500,
  STORAGE_UNAVAILABLE: 503,
  EMAIL_DELIVERY_FAILED: 503,
  PDF_GENERATION_FAILED: 503,
  QUEUE_UNAVAILABLE: 503,
  DEPENDENCY_UNAVAILABLE: 503,
} satisfies Record<ErrorCode, number>;

// ── Response envelope ─────────────────────────────────────────────────────────

/** Field-level validation details: `{ field: messageKey }`. */
export type ErrorDetails = Record<string, string> | Record<string, unknown>;

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: ErrorDetails;
}

export interface SuccessEnvelope<T> {
  data: T;
  meta: Record<string, unknown>;
  error: null;
}

export interface ErrorEnvelope {
  data: null;
  meta: Record<string, unknown>;
  error: ApiErrorBody;
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

// ── List query grammar + meta ───────────────────────────────────────────────

export interface SortSpec {
  key: string;
  order: "asc" | "desc";
}

export interface ListMeta {
  page: number;
  limit: number;
  total: number;
  pageCount: number;
  sort: SortSpec[];
  q?: string;
  [k: string]: unknown;
}

export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 200;

export type ArchivedFilter = "false" | "true" | "all";

// ── Base document mixin ─────────────────────────────────────────────────────

/** Applied to every persisted entity. `version` = optimistic concurrency; `deletedAt` = soft-delete. */
export interface BaseDoc {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  deletedAt?: string | null;
  /**
   * Tenant boundary. Every account-scoped document carries the owning account's
   * id; the repository layer stamps + filters it (fail-closed). Globals (accounts,
   * sessions) are stored via GlobalRepository and do NOT carry this. Users are
   * global too but reuse this field to record their home account (`null` for the
   * sysadmin), so it permits `null`.
   */
  accountId?: string | null;
}

// ── Identity / authorization context ────────────────────────────────────────

/**
 * `sysadmin` is a GLOBAL super-role that lives above accounts: it manages the
 * `accounts` collection and can assume any account. Inside an assumed account it
 * is still scoped to that account for normal reads (isolation is not bypassed);
 * only explicit account-management endpoints operate cross-account.
 */
export type Role = "sysadmin" | "administrator" | "member";

export interface Capabilities {
  canManageSettings: boolean;
  canManageUsers: boolean;
  canPermanentlyDelete: boolean;
  canViewFinancialTotals: boolean;
  canExportData: boolean;
}

/**
 * The mandatory scope threaded to every repository method.
 * Assembled by the session middleware. Its presence is type-enforced AND
 * runtime-guarded — a repository cannot run a query without it.
 */
export interface AuthContext {
  userId: string;
  role: Role;
  capabilities: Capabilities;
  /**
   * The account this request operates within. For normal users it is their own
   * `user.accountId`; for a sysadmin it is the account they have assumed
   * (session `activeAccountId`). The repository layer filters + stamps every
   * account-scoped document by this value. Empty only for the narrow set of
   * global/cross-account sysadmin endpoints (which use GlobalRepository).
   */
  accountId: string;
  /** True when the principal is the global sysadmin (cross-account management). */
  isSysadmin?: boolean;
}

/** Whitelist of query-able fields per resource (keeps list queries index-backed). */
export interface ListWhitelist {
  sortable: readonly string[];
  filterable: readonly string[];
  searchable: readonly string[];
}
