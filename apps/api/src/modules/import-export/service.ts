import type { Db } from "mongodb";
import type { AuthContext } from "@billy/types";
import { errors, type Logger } from "@billy/shared";
import { assertCapability, type DomainEventEmitter } from "@/platform/service.js";
import type { ExportFormat, ExportResource, ExportResult } from "@/modules/import-export/types.js";

/**
 * Export engine. Reads the scoped
 * collection read-only and serializes it as CSV or JSON. Gated by `canExportData`
 * — administrators bypass. This is the SYNC path;
 * worker offload for large sets is deferred.
 *
 * Anti-duplication: the DSAR subject-access export
 * reuses THIS engine — it is the single exporter, not a second one.
 */

/**
 * Resource → Mongo collection whitelist. ONLY these may be exported.
 * `users`/`sessions` and any other identity/credential store are absent by
 * design, so a request for them fails the whitelist lookup below. Every listed
 * collection carries the BaseDoc soft-delete field, so every read filters
 * `deletedAt:null`.
 */
export const EXPORT_COLLECTIONS: Readonly<Record<ExportResource, string>> = {
  clients: "clients",
  expenses: "expenses",
  contracts: "contracts",
  "time-entries": "timeEntries",
  subscriptions: "subscriptions",
  quotes: "quotes",
  invoices: "invoices",
};

/**
 * Secret-ish fields stripped from EVERY exported row (defense in depth against
 * exported field leaks). The whitelisted collections should never contain these
 * — they live in `users`, which is not exportable — but we redact unconditionally
 * so a mis-shaped document can never leak a credential. `_id` is dropped too: we
 * read the raw collection (not the `{_id:0}`-projecting repository), and the API
 * contract exposes `id`, never Mongo's `_id`.
 */
const REDACTED_FIELDS: readonly string[] = [
  "_id",
  "passwordHash",
  "password",
  "twoFactorSecret",
  "totpSecret",
  "sessionToken",
  "resetToken",
  "apiKey",
  "secret",
];

/** Type guard: a value is a valid, whitelisted export resource. */
export function isExportResource(resource: string): resource is ExportResource {
  return Object.prototype.hasOwnProperty.call(EXPORT_COLLECTIONS, resource);
}

export const toCsv = (rows: Record<string, unknown>[]): string => {
  const header: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        header.push(key);
      }
    }
  }

  const lines: string[] = [];
  lines.push(header.map(csvField).join(","));
  for (const row of rows) {
    lines.push(header.map((key) => csvField(row[key])).join(","));
  }
  return lines.join("\r\n");
};

const csvField = (value: unknown): string => {
  const str = csvStringify(value);
  if (/[",\r\n]/u.test(str)) {
    return `"${str.replace(/"/gu, '""')}"`;
  }
  return str;
};

const csvStringify = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const redactRow = (row: Record<string, unknown>): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...row };
  for (const field of REDACTED_FIELDS) delete copy[field];
  return copy;
};

export interface ExportServiceDeps {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
}

export class ExportService {
  private readonly db: Db;
  private readonly emitter: DomainEventEmitter;
  private readonly logger: Logger;

  constructor(deps: ExportServiceDeps) {
    this.db = deps.db;
    this.emitter = deps.emitter;
    this.logger = deps.logger;
  }

  /**
   * Export a whitelisted resource as CSV or JSON. Guards run BEFORE any
   * db access, so denial/whitelist paths never touch Mongo:
   *   1. `canExportData` — administrators bypass → else CAPABILITY_DENIED.
   *   2. resource whitelist — unknown/sensitive resource → VALIDATION_FAILED.
   * Then reads the scoped collection (`deletedAt:null`), redacts secret fields,
   * and serializes. Emits an audit-relevant `export.performed` event.
   */
  async export(ctx: AuthContext, resource: string, format: ExportFormat): Promise<ExportResult> {
    assertCapability(ctx, "canExportData");

    if (!isExportResource(resource)) {
      throw errors.validation("Unknown or non-exportable resource", { resource: "field.unsupported" });
    }

    const collectionName = EXPORT_COLLECTIONS[resource];
    // Account-scoped: export only the caller's account's rows (this reads the
    // collection directly, bypassing BaseRepository, so it must scope itself).
    const raw = (await this.db
      .collection(collectionName)
      .find({ deletedAt: null, accountId: ctx.accountId })
      .toArray()) as Record<string, unknown>[];
    const rows = raw.map(redactRow);

    const date = new Date().toISOString().slice(0, 10);
    const filename = `${resource}-${date}.${format}`;
    const body = format === "csv" ? toCsv(rows) : JSON.stringify(rows);
    const contentType = format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8";

    await this.emitter.emit({
      name: "export.performed",
      actorId: ctx.userId,
      entityType: "export",
      entityId: resource,
      payload: { resource, format, count: rows.length },
    });
    this.logger.info({ resource, format, count: rows.length }, "export.performed");

    return { filename, contentType, body, count: rows.length };
  }
}
