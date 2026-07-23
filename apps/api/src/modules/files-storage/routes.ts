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

  // GET /api/v1/files/:id/download-url — authorize → scan-gate → short-TTL presigned GET.
  r.get("/:id/download-url", async (ctx) => {
    const result = await service.requestDownload(ctx.state.authContext!, ctx.params.id!);
    respondOk(ctx, result);
  });

  // GET /api/v1/files/:id/content — authorize → scan-gate → STREAM the bytes
  // through the API. Same-origin so the browser needs no MinIO reachability (a
  // presigned URL is signed for the object store's internal Docker host and is
  // unreachable from the user's browser). Auth cookie rides along on the GET.
  r.get("/:id/content", async (ctx) => {
    const { file, stream } = await service.streamDownload(ctx.state.authContext!, ctx.params.id!);
    ctx.set("Content-Type", file.contentType || "application/octet-stream");
    // `attachment` so the browser downloads rather than renders; quote-escape the filename.
    const safeName = (file.filename || "download").replace(/["\\]/g, "_");
    ctx.set("Content-Disposition", `attachment; filename="${safeName}"`);
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
