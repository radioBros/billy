/**
 * Files-storage upload helper.
 *
 * The upload is a 2-step, SAME-ORIGIN dance:
 *   1. POST /v1/files/request-upload      → { fileId }                (api-client)
 *   2. PUT  /v1/files/:id/content  (raw bytes, streamed through the API → MinIO,
 *      which also confirms + scans)                                   (RAW fetch)
 *
 * Step 2 streams to OUR OWN origin, NOT to MinIO. A MinIO presigned URL is signed
 * for the object store's internal Docker host (`minio:9000`) which is unreachable
 * from a real browser in a self-host deployment — so the API relays the bytes.
 * It's a raw `fetch` (not the api-client) because the body is binary, not JSON;
 * `credentials: "include"` sends the auth cookie. The response IS the confirmed
 * FileObject envelope, so there is no separate confirm call to lose.
 */
import { api } from "@/api/client";
import { apiBaseUrl } from "@/config";
import type { FileUploadTicket } from "@/types/domain";

export const logoUrlFor = (fileId: string): string => {
  const base = apiBaseUrl().replace(/\/$/u, "");
  return `${base}/v1/files/${fileId}/content`;
};

/**
 * Upload a file via the request-upload → PUT → confirm flow. `owner` scopes the
 * stored FileObject; branding assets (logo/favicon/company-logo/login bg) default
 * to the "branding" owner. The request body MUST carry ownerType/ownerId/sizeBytes
 * (the server schema requires them) — omitting them fails with VALIDATION_FAILED.
 */
export const uploadFile = async (
  file: File,
  owner: { ownerType: string; ownerId: string } = { ownerType: "branding", ownerId: "branding" },
): Promise<string> => {
  const contentType = file.type || "application/octet-stream";
  const ticket = await api.post<FileUploadTicket>("/v1/files/request-upload", {
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    filename: file.name,
    contentType,
    sizeBytes: file.size,
  });

  // request-upload responds with the created FileObject under `file` — the id is
  // `file.id` (NOT a top-level `fileId`). Guard so a shape drift fails loudly here
  // instead of PUTting to `/files/undefined/content`.
  const fileId = ticket.file?.id;
  if (!fileId) {
    throw new Error("Upload failed: request-upload returned no file id");
  }

  // Stream the raw bytes to OUR OWN API (same-origin); it relays to MinIO and
  // confirms+scans in one call. Not the api-client (body is binary, not JSON).
  const base = apiBaseUrl().replace(/\/$/u, "");
  const putRes = await fetch(`${base}/v1/files/${fileId}/content`, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
    credentials: "include",
  });
  if (!putRes.ok) {
    throw new Error(`Upload failed (${putRes.status})`);
  }
  return fileId;
};
