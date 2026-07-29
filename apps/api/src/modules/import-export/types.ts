/**
 * Import/export module types.
 *
 * This implements SYNC EXPORT only. Import and async/worker offload are deferred.
 */

/** Machine-readable export formats supported by the sync exporter. */
export type ExportFormat = "csv" | "json";

/**
 * Whitelist of resources that MAY be exported. Each maps a public URL
 * segment (`:resource`) to a Mongo collection name. Collections holding
 * credentials/identity (`users`, `sessions`) are deliberately ABSENT — export is
 * refused for anything not in this map (defense in depth against export leaks).
 */
export type ExportResource =
  | "clients"
  | "expenses"
  | "contracts"
  | "time-entries"
  | "subscriptions"
  | "quotes"
  | "invoices";

/**
 * Result of a sync export: a ready-to-send file body plus its transport headers.
 * The service returns this so the controller stays a thin marshaller and
 * the composition is unit-testable without a Koa context.
 */
export interface ExportResult {
  /** Content-Disposition filename, e.g. `clients-2026-07-16.csv`. */
  filename: string;
  /** Response Content-Type (text/csv or application/json). */
  contentType: string;
  /** The serialized file body (CSV text or JSON string). */
  body: string;
  /** Number of rows exported (for the audit event payload). */
  count: number;
}
