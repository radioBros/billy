import type { AuthContext, BaseDoc } from "@billy/types";

/**
 * File-storage entity + hook contracts. This is the MVP `FileObject`
 * shape; the fuller production metadata list
 * (bucket/checksum/entityType…) is intentionally NOT merged in
 * here — this module owns exactly the fields below.
 *
 * Object keys are server-generated (never derived from the client filename) so a
 * malicious name cannot cause path traversal / overwrite.
 */

/** AV scan lifecycle. A file is only signable when `clean`. */
export type ScanStatus = "pending" | "clean" | "infected";

/**
 * The owning entity a file is attached to (client attachment, expense receipt,
 * contract doc, invoice/quote PDF, logo …). Kept as a free string pair rather than a
 * closed enum so consumers can attach without editing this module; authorization is
 * delegated to the pluggable {@link FileAuthorizer}.
 */
export interface FileOwner {
  ownerType: string;
  ownerId: string;
}

export interface FileObject extends BaseDoc {
  /** Owning-entity discriminator (e.g. "client", "expense", "invoice"). */
  ownerType: string;
  /** Owning-entity id (string ObjectId). */
  ownerId: string;
  /** Client-supplied display name — NEVER used to build the object key. */
  filename: string;
  /** Declared/validated MIME type (allow-listed). */
  contentType: string;
  /** Size in bytes (recorded at confirm; size-capped). */
  sizeBytes: number;
  /** Server-generated MinIO object key (`ownerType/ownerId/uuid`). */
  objectKey: string;
  /** AV scan state — gates downloadability. */
  scanStatus: ScanStatus;
  /** User id that initiated the upload. */
  uploadedBy: string;
}

/**
 * Authorize-before-sign hook. Called BEFORE any presigned URL is minted and
 * before a pending doc is written. Throws (FORBIDDEN) to deny. Pluggable — the real
 * per-entity authorization (resolve owning entity → permissions) is owned by
 * consumers; the default is allow because no entity resolver exists here.
 */
export type FileAction = "upload" | "download" | "delete";

export type FileAuthorizer = (
  ctx: AuthContext,
  owner: FileOwner,
  action: FileAction,
) => void | Promise<void>;

/**
 * Antivirus scan hook (ClamAV sidecar assumed). Pluggable with NO
 * hard dependency: when absent the pipeline treats files as `clean` (documented
 * self-host tradeoff, not silent). When present, `confirmUpload`
 * records its verdict; `infected` files are never signable for download.
 */
export interface FileScanner {
  scan(objectKey: string): Promise<Exclude<ScanStatus, "pending">>;
}
