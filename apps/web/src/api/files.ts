/**
 * Files-storage upload helper.
 *
 * The upload is a 3-step authorize-before-sign dance:
 *   1. POST /v1/files/request-upload  → { fileId, uploadUrl, headers? }  (api-client)
 *   2. PUT the raw bytes to `uploadUrl`                                   (RAW fetch)
 *   3. POST /v1/files/:id/confirm                                        (api-client)
 *
 * Step 2 MUST use a raw `fetch` — the presigned URL is an absolute (often
 * off-origin, S3-style) URL that must NOT get the api-client's base-URL prefix,
 * `credentials: include`, or envelope parsing. Steps 1 & 3 go through the client.
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
  const ticket = await api.post<FileUploadTicket>("/v1/files/request-upload", {
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    filename: file.name,
    contentType: file.type || "application/octet-stream",
    sizeBytes: file.size,
  });

  const putHeaders: Record<string, string> = {
    "Content-Type": file.type || "application/octet-stream",
    ...(ticket.headers ?? {}),
  };
  const putRes = await fetch(ticket.uploadUrl, {
    method: "PUT",
    headers: putHeaders,
    body: file,
  });
  if (!putRes.ok) {
    throw new Error(`Upload failed (${putRes.status})`);
  }

  // Confirm records the authoritative size + re-runs the scan hook (schema requires sizeBytes).
  await api.post<unknown>(`/v1/files/${ticket.fileId}/confirm`, {
    sizeBytes: file.size,
    contentType: file.type || "application/octet-stream",
  });
  return ticket.fileId;
};
