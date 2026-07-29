/**
 * Backend validation-detail translation. The API's VALIDATION_FAILED envelope
 * carries `details` as `{ "lineItems.0.description": "field.required", … }` —
 * machine codes, not user-facing text. This maps the known codes to the
 * `validations.*` i18n slice (falling back to the raw code for unknown ones)
 * and renders a verbose, human-readable summary for toasts/alerts so the user
 * is told exactly WHICH field failed and WHY.
 */
import { i18n } from "@/plugins/i18n";

/** Known backend message codes → i18n keys (see @billy/validation). */
const CODE_KEYS: Record<string, string> = {
  "field.required": "validations.requiredField",
  "line_items.required": "validations.lineItemsRequired",
  "quantity.must_be_positive": "validations.quantityPositive",
  "currency.invalid": "validations.currencyInvalid",
  "date.due_before_issue": "validations.dueBeforeIssue",
};

const t = (key: string, params?: Record<string, unknown>): string =>
  params ? i18n.global.t(key, params) : i18n.global.t(key);

/** Translate one backend message code; unknown codes pass through verbatim. */
export const translateValidationCode = (code: string): string => {
  const key = CODE_KEYS[code];
  return key ? t(key) : code;
};

/**
 * Translate every string value of an error `details` object, keeping the keys
 * (field paths) intact — ready to feed `:error-messages` bindings.
 */
export const translateValidationDetails = (
  details: Record<string, unknown> | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {};
  if (details && typeof details === "object") {
    for (const [k, v] of Object.entries(details)) {
      if (typeof v === "string") out[k] = translateValidationCode(v);
    }
  }
  return out;
};

/** "lineItems" → "line items"; "unitPriceMinor" → "unit price minor". */
const humanizeSegment = (segment: string): string =>
  segment.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase();

/**
 * Humanize a field path: `lineItems.0.description` →
 * "line items #1 · description". Array indices become 1-based `#N` markers.
 */
export const humanizeFieldPath = (path: string): string => {
  const parts = path.split(".");
  const out: string[] = [];
  for (const part of parts) {
    if (/^\d+$/u.test(part)) out.push(`#${Number(part) + 1}`);
    else out.push(humanizeSegment(part));
  }
  return out.join(" · ");
};

/**
 * Verbose one-line summary of a translated details object, for toasts:
 * "line items · #1 · description: This field is required".
 */
export const summarizeValidationDetails = (translated: Record<string, string>): string => {
  return Object.entries(translated)
    .map(([path, message]) => `${humanizeFieldPath(path)}: ${message}`)
    .join("; ");
};

// ── Whole-error translation (any ApiError → one verbose, translated sentence) ──

/** Minimal ApiError shape (structural, so this util never imports the client). */
interface ApiErrorLike {
  code: string;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Translate a canonical ErrorCode via the `errors.codes.*` catalog. The lookup
 * is DYNAMIC — any code present in the catalog resolves without code changes
 * here; a code missing from the catalog falls back to the raw code so new
 * backend codes degrade gracefully instead of breaking.
 */
export const translateErrorCode = (code: string): string => {
  const key = `errors.codes.${code}`;
  return i18n.global.te(key) ? t(key) : code;
};

/**
 * Parse an error `details` object into a translated, human-readable summary.
 *  - string values are treated as field-validation codes ("field.required") →
 *    "line items · #1 · description: This field is required"
 *  - number values are treated as counts (e.g. CLIENT_HAS_DOCUMENTS) →
 *    "invoices: 20; quotes: 9"
 * Unknown shapes are skipped. Returns "" when nothing is presentable.
 */
export const summarizeErrorDetails = (details: Record<string, unknown> | undefined): string => {
  if (!details || typeof details !== "object") return "";
  const parts: string[] = [];
  for (const [path, value] of Object.entries(details)) {
    if (typeof value === "string") parts.push(`${humanizeFieldPath(path)}: ${translateValidationCode(value)}`);
    else if (typeof value === "number") parts.push(`${humanizeFieldPath(path)}: ${value}`);
  }
  return parts.join("; ");
};

/**
 * One verbose, translated reason for ANY ApiError — the single entry point every
 * toast/alert interpolates: the catalog sentence for the code, plus the parsed
 * `details` when they add information (which fields failed, what counts blocked
 * the action). Designed to slot into existing "…: {code}" message templates.
 */
export const apiErrorReason = (err: ApiErrorLike): string => {
  const base = translateErrorCode(err.code);
  const detail = summarizeErrorDetails(err.details);
  return detail ? `${base} — ${detail}` : base;
};
