import Router from "@koa/router";
import type { Db } from "mongodb";
import type { Logger } from "@billy/shared";
import type { AppState } from "@/app.js";
import type { MinioConn } from "@/infrastructure/minio.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import { validate } from "@/platform/validate.js";
import { respondCreated, respondList, respondOk } from "@/platform/serializer.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import { FileObjectRepository, FILES_COLLECTION } from "@/modules/files-storage/repository.js";
import { FileService } from "@/modules/files-storage/service.js";
import { ConfirmUploadSchema, RequestUploadSchema } from "@/modules/files-storage/schema.js";
import type { FileObject } from "@/modules/files-storage/types.js";

export const createFilesStorageRouter = (deps: {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
  minio: MinioConn;
}): Router<AppState> => {
  const repo = new FileObjectRepository(deps.db.collection<FileObject>(FILES_COLLECTION));
  const service = new FileService({
    repo,
    emitter: deps.emitter,
    logger: deps.logger,
    minio: deps.minio,
  });

  const r = new Router<AppState>({ prefix: "/api/v1/files" });

  r.use(requireAuth);

  // POST /api/v1/files/request-upload — authorize → validate → pending doc → presigned PUT.
  r.post("/request-upload", async (ctx) => {
    const input = validate(RequestUploadSchema, ctx.request.body);
    const result = await service.requestUpload(ctx.state.authContext!, input);
    respondCreated(ctx, result);
  });

  // POST /api/v1/files/:id/confirm — record size/type + run AV scan hook.
  r.post("/:id/confirm", async (ctx) => {
    const input = validate(ConfirmUploadSchema, ctx.request.body);
    const file = await service.confirmUpload(ctx.state.authContext!, ctx.params.id!, input);
    respondOk(ctx, file);
  });

  // NOTE: there is deliberately NO `/download-url` presign route. Presigned URLs are
  // signed for MinIO's internal Docker host (`minio:9000`), unreachable from a real
  // browser in a self-host deployment — so ALL browser file transfer goes same-origin
  // through the API: GET `/content` (download) and PUT `/content` (upload) below.

  // PUT /api/v1/files/:id/content — same-origin upload: STREAM the raw request body
  // through the API into MinIO, then confirm. Counterpart to the GET below — the
  // browser never PUTs to MinIO directly (a presigned URL is signed for the internal
  // Docker host, unreachable from a real browser). koa-bodyparser ignores binary
  // content types, so `ctx.req` is the untouched raw byte stream.
  r.put("/:id/content", async (ctx) => {
    const contentType = ctx.get("content-type") || undefined;
    const lenHeader = ctx.get("content-length");
    const sizeBytes = lenHeader && /^\d+$/u.test(lenHeader) ? Number(lenHeader) : undefined;
    const file = await service.streamUpload(ctx.state.authContext!, ctx.params.id!, ctx.req, {
      contentType,
      sizeBytes,
    });
    respondOk(ctx, file);
  });

  // GET /api/v1/files/:id/content — authorize → scan-gate → STREAM the bytes
  // through the API. Same-origin so the browser needs no MinIO reachability (a
  // presigned URL is signed for the object store's internal Docker host and is
  // unreachable from the user's browser). Auth cookie rides along on the GET.
  r.get("/:id/content", async (ctx) => {
    const { file, stream } = await service.streamDownload(ctx.state.authContext!, ctx.params.id!);
    const contentType = file.contentType || "application/octet-stream";
    ctx.set("Content-Type", contentType);
    // Images AND PDFs render INLINE (so `<img src>` previews / logos display and PDFs
    // preview in an `<iframe>`); everything else (DOCX, XLSX, …) is `attachment` so the
    // browser downloads rather than tries to render it. SVGs are served inline via
    // `<img>` only — the img context neutralizes any embedded script (no inline-SVG /
    // no top-level navigation render). `X-Content-Type-Options: nosniff` (set globally)
    // keeps the browser from re-interpreting the type.
    const safeName = (file.filename || "download").replace(/["\\]/g, "_");
    const inlineType = contentType.startsWith("image/") || contentType === "application/pdf";
    const disposition = inlineType ? "inline" : "attachment";
    ctx.set("Content-Disposition", `${disposition}; filename="${safeName}"`);
    if (file.sizeBytes) ctx.set("Content-Length", String(file.sizeBytes));
    ctx.body = stream;
  });

  // GET /api/v1/files — list (server paginate/sort/search).
  r.get("/", async (ctx) => {
    const { items, meta } = await service.list(ctx.state.authContext!, ctx.query);
    respondList(ctx, items, meta);
  });

  // DELETE /api/v1/files/:id — authorize → removeObject → soft-delete metadata.
  r.delete("/:id", async (ctx) => {
    await service.delete(ctx.state.authContext!, ctx.params.id!);
    respondOk(ctx, { ok: true });
  });

  return r;
};
