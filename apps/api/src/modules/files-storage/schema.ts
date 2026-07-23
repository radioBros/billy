import { z } from "zod";
import type { ListWhitelist } from "@billy/types";
import { NonEmptyString, ObjectIdString } from "@billy/validation";

/**
 * File-storage Zod schemas (one schema per entity). Shape only;
 * MIME allow-list + size cap are enforced in the service against the request body.
 * Object keys are server-generated, so the client never sends
 * one — only `filename`/`contentType`/`sizeBytes` and the owning-entity ref.
 */

/**
 * Allow-listed MIME types: PDF, PNG,
 * JPG/JPEG, WebP, SVG, DOCX, XLSX, TXT. Anything else → UNSUPPORTED_FILE_TYPE.
 * SVG is allowed for branding logos/icons (operator-approved): it's served via the
 * scan-gated `/content` route with `Content-Disposition: attachment` and only ever
 * rendered through `<img src>` — both neutralize embedded scripts (no inline SVG /
 * no navigation-render), so the script-in-image vector doesn't
 * apply on these surfaces.
 */
export const ALLOWED_MIME_TYPES: readonly string[] = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // DOCX
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // XLSX
  "text/plain",
] as const;

/** Default per-file size cap (configurable, sensible default 25 MB). */
export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** POST /request-upload — mint a presigned PUT + a pending FileObject (authorize first). */
export const RequestUploadSchema = z.object({
  ownerType: NonEmptyString,
  ownerId: NonEmptyString,
  filename: NonEmptyString,
  contentType: NonEmptyString,
  /** Declared size for the pre-sign size guard; the authoritative size is recorded at confirm. */
  sizeBytes: z.number().int().positive(),
});

/** POST /:id/confirm — record the stored object's real size/type + run the scan hook. */
export const ConfirmUploadSchema = z.object({
  sizeBytes: z.number().int().positive(),
  contentType: NonEmptyString.optional(),
});

export type RequestUploadInput = z.infer<typeof RequestUploadSchema>;
export type ConfirmUploadInput = z.infer<typeof ConfirmUploadSchema>;

/** List query whitelist (index-backed). */
export const FILE_LIST_WHITELIST: ListWhitelist = {
  sortable: ["createdAt", "updatedAt", "filename", "sizeBytes"],
  filterable: ["ownerType", "ownerId", "contentType", "scanStatus", "uploadedBy"],
  searchable: ["filename"],
};

/** Exported for reuse by consumers that want to validate an id path param. */
export const FileIdSchema = ObjectIdString;
