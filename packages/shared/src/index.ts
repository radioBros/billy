import { pino, type Logger } from "pino";
import { randomUUID } from "node:crypto";
import {
  ERROR_STATUS,
  type ApiErrorBody,
  type ErrorCode,
  type ErrorDetails,
  type ErrorEnvelope,
  type SuccessEnvelope,
} from "@billy/types";

export type { Logger } from "pino";

// ── Logging ───────────────────────────────────────────────────────────────────

export function createLogger(opts: { level: string; pretty: boolean; service: string }): Logger {
  return pino({
    level: opts.level,
    base: { service: opts.service },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/** Request correlation id (`requestId`). */
export function createRequestId(): string {
  return randomUUID();
}

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Application error carrying a canonical {@link ErrorCode}. The HTTP status is
 * derived from the registry ({@link ERROR_STATUS}) unless explicitly overridden.
 * The outermost middleware maps any `AppError` to the response envelope; any
 * non-`AppError` throw becomes `INTERNAL_ERROR` (500) with no detail leak.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetails;

  constructor(code: ErrorCode, message?: string, options?: { status?: number; details?: ErrorDetails }) {
    super(message ?? code);
    this.name = "AppError";
    this.code = code;
    this.status = options?.status ?? ERROR_STATUS[code];
    this.details = options?.details;
  }

  toBody(): ApiErrorBody {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

/** Common factories (thin sugar so call sites stay readable). */
export const errors = {
  notFound: (message = "Resource not found") => new AppError("RESOURCE_NOT_FOUND", message),
  unauthenticated: (message = "Authentication required") => new AppError("UNAUTHENTICATED", message),
  forbidden: (message = "Forbidden") => new AppError("FORBIDDEN", message),
  validation: (message = "Validation failed", details?: ErrorDetails) =>
    new AppError("VALIDATION_FAILED", message, { details }),
  versionConflict: (message = "Version conflict") => new AppError("VERSION_CONFLICT", message),
  internal: (message = "Internal server error") => new AppError("INTERNAL_ERROR", message),
} as const;

// ── Envelope builders ─────────────────────────────────────────────────────────

export function successEnvelope<T>(data: T, meta: Record<string, unknown> = {}): SuccessEnvelope<T> {
  return { data, meta, error: null };
}

/**
 * Build an error envelope from any thrown value. Non-`AppError` throws are
 * mapped to `INTERNAL_ERROR` and never leak their message/stack.
 */
export function errorEnvelope(err: unknown): { status: number; body: ErrorEnvelope } {
  const appErr = err instanceof AppError ? err : errors.internal();
  return {
    status: appErr.status,
    body: { data: null, meta: {}, error: appErr.toBody() },
  };
}

// ── Document placeholder engine ────────────────────────────────────────────────
export {
  resolvePlaceholders,
  formatDate,
  KNOWN_TOKENS,
  type TemplateContext,
  type TemplateAddress,
} from "./template.js";

// ── Recurrence date math ────────────────────────────────────────────────────────
export {
  advanceRecurrence,
  firstRunOnOrAfter,
  daysInMonth,
  type RecurringInterval as SharedRecurringInterval,
} from "./recurrence.js";

// ── Locales (single source of truth) ────────────────────────────────────────────
export {
  LOCALES,
  LOCALE_CODES,
  DEFAULT_LOCALE,
  isSupportedLocale,
  normalizeLocale,
  resolveDocumentLocale,
  countryName,
  type LocaleInfo,
} from "./locales.js";

// ── Document/email structural labels (localized to the recipient) ─────────────────
export { docLabels, type DocLabels } from "./doc-labels.js";

// ── Localized company free-text (per-language notes/header/footer) ────────────────
export {
  resolveLocalized,
  isLocalizedMap,
  toLocalizedMap,
  type LocalizedText,
} from "./localized-text.js";
