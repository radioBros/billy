/// <reference path="./pino-roll.d.ts" />
import { pino, multistream, type Logger, type StreamEntry, type Level } from "pino";
import pinoRoll from "pino-roll";
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

/**
 * Options for {@link createLogger}.
 *
 * The `file*` knobs are OPTIONAL and OFF by default: existing callers (and the
 * ~25 test sites) that pass only `{ level, pretty, service }` keep the exact
 * old behaviour (plain-JSON to stdout, no files, no directory creation). The
 * api/worker entry points opt in explicitly from validated config.
 */
export interface CreateLoggerOptions {
  level: string;
  /** Reserved (accepted historically, no-op today — stdout stays plain JSON). */
  pretty: boolean;
  /** Per-service base name; drives `base.service` AND the log file prefix. */
  service: string;
  /**
   * Enable the ADDITIVE rotating-file sink. When false/omitted, only stdout is
   * used and NO directory/file is touched (keeps tests hermetic).
   */
  fileEnabled?: boolean;
  /** Directory the rotating files live in (created if missing). */
  fileDir?: string;
  /** Max size per segment before an intra-day size-roll, e.g. `"20m"`. */
  fileMaxSize?: string;
  /** Retention window in days; sizes pino-roll's file `count` (see below). */
  fileRetentionDays?: number;
}

/**
 * Build the app logger.
 *
 * stdout ALWAYS receives the full stream (plain JSON, as before — Docker's
 * json-file driver + `docker logs` keep working). When the file sink is enabled
 * it is layered on top via `pino.multistream` so the SAME records at the SAME
 * level also land in durable rotating files.
 *
 * ── Why `pino.multistream`, not `transport: { targets }` ──────────────────────
 * The api/worker ship as a SINGLE esbuild bundle (scripts/build-service.mjs)
 * with a deliberately minimal runtime `node_modules`. pino's `transport` option
 * spawns a worker thread that `require()`s the target module BY NAME at runtime
 * — which a bundled, inlined `pino-roll` cannot satisfy without marking it
 * external and shipping it in the mounted prod node_modules (touching the docker
 * build + deploy model). `multistream` and `pino-roll` both run IN-PROCESS
 * (pino-roll is just a SonicBoom wrapper — no worker thread), so everything
 * stays inside the one bundle with zero externals. Same reason the project
 * already avoids `pino-pretty`.
 */
export function createLogger(opts: CreateLoggerOptions): Logger {
  const common = {
    level: opts.level,
    base: { service: opts.service },
    formatters: { level: (label: string) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (!opts.fileEnabled) {
    // Legacy / test path — unchanged behaviour, no filesystem side effects.
    return pino(common);
  }

  const dir = opts.fileDir ?? "./logs";
  const retentionDays = opts.fileRetentionDays ?? 7;

  // stdout stream carries EVERYTHING at `level` (Docker logs preserved).
  const streams: StreamEntry[] = [{ level: opts.level as Level, stream: process.stdout }];

  const streamMulti = multistream(streams, { dedupe: false });
  const logger = pino(common, streamMulti);

  // pino-roll's builder is ASYNC (returns a Promise<SonicBoom>). We keep
  // `createLogger` SYNCHRONOUS (25 call sites + the entry points rely on that)
  // and simply `.add()` the file stream to the live multistream once it
  // resolves. Cost: the first handful of boot lines only reach stdout, not the
  // file — acceptable, and far cheaper than making the whole signature async.
  //
  // Filename: pino-roll builds `${file}.${date}.${n}${ext}` → e.g.
  //   ./logs/api.2026-07-29.1.log
  // so api and worker never interleave (the `service` prefix separates them).
  //
  // Retention: pino-roll v4 has NO true age-based deletion — `limit.count` is
  // mandatory and means "keep the newest N files" (cleanup fires only on a
  // roll). With daily + size rotation a single day can produce several numbered
  // segments, so a strict `count: 7` could evict same-day segments early.
  // Instead we budget a generous number of size-rolled segments PER DAY and
  // multiply by the retention window. `removeOtherLogFiles: true` makes cleanup
  // scan the whole directory and sort by the DATE embedded in each filename
  // (then segment number), keeping the newest `count` — so history survives
  // container restarts (without it, pino-roll only prunes files it created in
  // the current process run). Net effect: at any plausible volume this keeps
  // AT LEAST ~`retentionDays` days; it only prunes below that if a day exceeds
  // MAX_SEGMENTS_PER_DAY × LOG_MAX_SIZE of logs. Hard ceiling ~168 files/service
  // (7 × 24) bounds disk use. We chose a per-day multiplier over a flat 30–70
  // count so a burst-heavy day can never silently discard that day's history.
  const MAX_SEGMENTS_PER_DAY = 24;
  const fileCount = Math.max(retentionDays, 1) * MAX_SEGMENTS_PER_DAY;

  void pinoRoll({
    file: `${dir}/${opts.service}`,
    extension: ".log",
    dateFormat: "yyyy-MM-dd",
    frequency: "daily",
    size: opts.fileMaxSize ?? "20m",
    mkdir: true,
    limit: { count: fileCount, removeOtherLogFiles: true },
  })
    .then((fileStream) => {
      streamMulti.add({ level: opts.level as Level, stream: fileStream });
    })
    .catch((err: unknown) => {
      // Never let a file-sink failure take down the process — stdout still works.
      logger.warn({ err }, "file log sink unavailable; continuing with stdout only");
    });

  return logger;
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
  PLACEHOLDER_CATALOG,
  placeholdersForDocType,
  type TemplateContext,
  type TemplateAddress,
  type PlaceholderInfo,
  type PlaceholderGroup,
  type PlaceholderDocType,
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
