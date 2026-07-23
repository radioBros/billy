import { randomUUID } from "node:crypto";
import type { AuthContext, BaseDoc, ListMeta } from "@billy/types";
import { AppError, errors } from "@billy/shared";
import { BaseService, type ServiceDeps } from "@/platform/service.js";
import type { MinioConn } from "@/infrastructure/minio.js";
import type { FileObjectRepository } from "@/modules/files-storage/repository.js";
import {
  ALLOWED_MIME_TYPES,
  DEFAULT_MAX_UPLOAD_BYTES,
  FILE_LIST_WHITELIST,
  type ConfirmUploadInput,
  type RequestUploadInput,
} from "@/modules/files-storage/schema.js";
import type { FileAuthorizer, FileObject, FileScanner } from "@/modules/files-storage/types.js";

/**
 * File-storage business logic (authorize-before-sign; MIME allow-list + size cap).
 * All logic lives here, never in controllers. Every repository
 * call threads the mandatory `authContext`.
 *
 * The signed-URL flow enforces **authorize-before-sign**: the injectable
 * {@link FileAuthorizer} runs — and must pass — BEFORE any presigned URL is minted
 * or any pending doc is written. MIME allow-list + size cap also
 * precede signing. Object keys are server-generated (never from the client filename).
 *
 * The AV {@link FileScanner} is pluggable with no hard dependency: absent ⇒
 * files default to `clean`; present ⇒ its verdict is recorded and an `infected`
 * (or still-`pending`) file is never signable for download.
 */

/** Default presigned-GET TTL — short (e.g. 60–300s). */
const DEFAULT_DOWNLOAD_TTL_SECONDS = 300;
/** Default presigned-PUT TTL — a short upload window. */
const DEFAULT_UPLOAD_TTL_SECONDS = 300;

/**
 * Bucket name for the files object store. `MinioConn` carries no bucket, so it is a
 * module constant here (integration note: keep in sync with the `minio-init`
 * bucket). Private bucket only — all access
 * is via signed URLs.
 */
export const FILES_BUCKET = "billy-files";

/** Default authorizer — allow. Real per-entity authorization is injected by consumers. */
const allowAll: FileAuthorizer = () => {
  /* no-op: default-allow; deny-capable authorizers are injected */
};

export interface FileServiceDeps extends ServiceDeps<FileObject> {
  repo: FileObjectRepository;
  minio: MinioConn;
  /** Injectable authorize-before-sign hook. Default allows. */
  authorizer?: FileAuthorizer;
  /** Pluggable AV scan hook. Absent ⇒ scanStatus defaults to `clean`. */
  scanner?: FileScanner;
  /** Configurable per-file size cap. */
  maxUploadBytes?: number;
  bucket?: string;
  downloadTtlSeconds?: number;
  uploadTtlSeconds?: number;
}

export interface RequestUploadResult {
  file: FileObject;
  uploadUrl: string;
  objectKey: string;
}

export class FileService extends BaseService<FileObject> {
  protected override readonly repo: FileObjectRepository;
  private readonly minio: MinioConn;
  private readonly authorizer: FileAuthorizer;
  private readonly scanner?: FileScanner;
  private readonly maxUploadBytes: number;
  private readonly bucket: string;
  private readonly downloadTtl: number;
  private readonly uploadTtl: number;

  constructor(deps: FileServiceDeps) {
    super(deps);
    this.repo = deps.repo;
    this.minio = deps.minio;
    this.authorizer = deps.authorizer ?? allowAll;
    this.scanner = deps.scanner;
    this.maxUploadBytes = deps.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    this.bucket = deps.bucket ?? FILES_BUCKET;
    this.downloadTtl = deps.downloadTtlSeconds ?? DEFAULT_DOWNLOAD_TTL_SECONDS;
    this.uploadTtl = deps.uploadTtlSeconds ?? DEFAULT_UPLOAD_TTL_SECONDS;
  }

  /**
   * Request an upload. Order is load-bearing:
   *   authorize → MIME allow-list → size cap → server-generate key → pending doc → presign PUT.
   * Nothing is signed until authorization AND validation pass.
   */
  async requestUpload(ctx: AuthContext, input: RequestUploadInput): Promise<RequestUploadResult> {
    // 1) Authorize BEFORE anything is signed or written.
    await this.authorize(ctx, { ownerType: input.ownerType, ownerId: input.ownerId }, "upload");

    // 2) MIME allow-list — reject disallowed type before signing.
    this.assertAllowedMime(input.contentType);

    // 3) Size cap — reject oversize before signing.
    this.assertWithinSize(input.sizeBytes);

    // 4) Server-generated object key — never derived from the client filename
    //    (path-traversal control). Namespaced by accountId so stored objects are
    //    physically partitioned per tenant (defense in depth on top of the
    //    account-scoped FileObject metadata).
    const objectKey = `${ctx.accountId}/${input.ownerType}/${input.ownerId}/${randomUUID()}`;

    // 5) Record a PENDING FileObject (not downloadable until confirmed + scanned clean).
    const file = await this.repo.insert(ctx, {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      objectKey,
      scanStatus: "pending",
      uploadedBy: ctx.userId,
    } as Omit<FileObject, keyof BaseDoc>);

    // 6) Only now mint the presigned PUT (authorize + validation both passed).
    const uploadUrl = await this.presign("upload", objectKey);

    await this.emit({
      name: "file.upload_requested",
      actorId: ctx.userId,
      entityType: "file",
      entityId: file.id,
      payload: { ownerType: file.ownerType, ownerId: file.ownerId },
    });
    return { file, uploadUrl, objectKey };
  }

  /**
   * Confirm an upload: record the stored object's real
   * size/type and run the AV scan hook. Absent scanner ⇒ `clean`.
   */
  async confirmUpload(ctx: AuthContext, id: string, input: ConfirmUploadInput): Promise<FileObject> {
    const existing = await this.repo.findById(ctx, id);
    if (!existing) throw errors.notFound();
    await this.authorize(ctx, { ownerType: existing.ownerType, ownerId: existing.ownerId }, "upload");

    // Re-validate against the confirmed values (defense in depth — client PUT is untrusted).
    const contentType = input.contentType ?? existing.contentType;
    this.assertAllowedMime(contentType);
    this.assertWithinSize(input.sizeBytes);

    // AV scan hook: present ⇒ record verdict; absent ⇒ default `clean` (self-host tradeoff).
    const scanStatus = this.scanner ? await this.scanner.scan(existing.objectKey) : "clean";

    const updated = await this.repo.updateVersioned(ctx, id, existing.version, {
      sizeBytes: input.sizeBytes,
      contentType,
      scanStatus,
    } as Partial<FileObject>);

    await this.emit({
      name: "file.confirmed",
      actorId: ctx.userId,
      entityType: "file",
      entityId: updated.id,
      payload: { scanStatus },
    });
    return updated;
  }

  /**
   * Request a download URL: authorize FIRST,
   * refuse to sign anything but a `clean` file, then mint a short-TTL presigned GET.
   */
  async requestDownload(ctx: AuthContext, id: string): Promise<{ file: FileObject; downloadUrl: string }> {
    const file = await this.repo.findById(ctx, id);
    if (!file) throw errors.notFound();

    // 1) Authorize BEFORE signing.
    await this.authorize(ctx, { ownerType: file.ownerType, ownerId: file.ownerId }, "download");

    // 2) Not signable unless the scan is clean (pending/infected blocked).
    if (file.scanStatus !== "clean") {
      throw new AppError("FORBIDDEN", `File not available (scan status: ${file.scanStatus})`);
    }

    // 3) Short-TTL presigned GET, single object.
    const downloadUrl = await this.presign("download", file.objectKey);
    return { file, downloadUrl };
  }

  /**
   * Stream a file's bytes through the API (authorize + scan-gate, same
   * as {@link requestDownload}). Used by the same-origin `/content` route so the
   * browser never needs to reach MinIO directly — a presigned URL is signed for
   * the object store's host (`minio:9000` inside Docker), which is unreachable
   * from the user's browser in a self-host deployment. Returns a readable stream
   * plus the metadata the route needs for Content-Type / Content-Disposition.
   */
  async streamDownload(
    ctx: AuthContext,
    id: string,
  ): Promise<{ file: FileObject; stream: NodeJS.ReadableStream }> {
    const file = await this.repo.findById(ctx, id);
    if (!file) throw errors.notFound();

    // 1) Authorize BEFORE reading the object.
    await this.authorize(ctx, { ownerType: file.ownerType, ownerId: file.ownerId }, "download");

    // 2) Never serve a non-clean file (pending/infected blocked).
    if (file.scanStatus !== "clean") {
      throw new AppError("FORBIDDEN", `File not available (scan status: ${file.scanStatus})`);
    }

    // 3) Stream the object (never buffer the whole thing into memory).
    try {
      const stream = await this.minio.client.getObject(this.bucket, file.objectKey);
      return { file, stream };
    } catch (err) {
      this.logger.error({ err, objectKey: file.objectKey }, "minio.getObject failed");
      throw new AppError("STORAGE_UNAVAILABLE", "Object storage unavailable");
    }
  }

  async list(
    ctx: AuthContext,
    rawQuery: Record<string, string | string[] | undefined>,
  ): Promise<{ items: FileObject[]; meta: ListMeta }> {
    const { items, parsed, total } = await this.repo.list(ctx, rawQuery, FILE_LIST_WHITELIST);
    const meta: ListMeta = {
      page: parsed.page,
      limit: parsed.limit,
      total,
      pageCount: Math.max(1, Math.ceil(total / parsed.limit)),
      sort: parsed.sortSpec,
      ...(parsed.q ? { q: parsed.q } : {}),
    };
    return { items, meta };
  }

  /**
   * Delete a file: authorize, remove the MinIO object,
   * then soft-delete the metadata doc. Object removal precedes the doc soft-delete so
   * a MinIO failure leaves the referencing metadata intact (no dangling reference).
   */
  async delete(ctx: AuthContext, id: string): Promise<void> {
    const file = await this.repo.findById(ctx, id);
    if (!file) throw errors.notFound();
    await this.authorize(ctx, { ownerType: file.ownerType, ownerId: file.ownerId }, "delete");

    await this.removeObject(file.objectKey);
    await this.repo.softDelete(ctx, id);

    await this.emit({
      name: "file.deleted",
      actorId: ctx.userId,
      entityType: "file",
      entityId: id,
    });
  }

  // ── Guards ──────────────────────────────────────────────────────────────────

  private async authorize(
    ctx: AuthContext,
    owner: { ownerType: string; ownerId: string },
    action: "upload" | "download" | "delete",
  ): Promise<void> {
    await this.authorizer(ctx, owner, action);
  }

  private assertAllowedMime(contentType: string): void {
    if (!ALLOWED_MIME_TYPES.includes(contentType)) {
      throw new AppError("UNSUPPORTED_FILE_TYPE", `Unsupported file type: ${contentType}`);
    }
  }

  private assertWithinSize(sizeBytes: number): void {
    if (sizeBytes > this.maxUploadBytes) {
      throw new AppError("FILE_TOO_LARGE", `File exceeds max size of ${this.maxUploadBytes} bytes`);
    }
  }

  // ── MinIO adapters (map transport failures to STORAGE_UNAVAILABLE) ────────────

  private async presign(kind: "upload" | "download", objectKey: string): Promise<string> {
    try {
      return kind === "upload"
        ? await this.minio.client.presignedPutObject(this.bucket, objectKey, this.uploadTtl)
        : await this.minio.client.presignedGetObject(this.bucket, objectKey, this.downloadTtl);
    } catch (err) {
      this.logger.error({ err, objectKey, kind }, "minio.presign failed");
      throw new AppError("STORAGE_UNAVAILABLE", "Object storage unavailable");
    }
  }

  private async removeObject(objectKey: string): Promise<void> {
    try {
      await this.minio.client.removeObject(this.bucket, objectKey);
    } catch (err) {
      this.logger.error({ err, objectKey }, "minio.removeObject failed");
      throw new AppError("STORAGE_UNAVAILABLE", "Object storage unavailable");
    }
  }
}
