import Router from "@koa/router";
import type { Db } from "mongodb";
import type { Context } from "koa";
import { errors, successEnvelope } from "@billy/shared";
import type { Logger } from "@billy/shared";
import type { AppState } from "@/app.js";
import type { MinioConn } from "@/infrastructure/minio.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import type { QueueRegistry } from "@/platform/queue.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import { FileObjectRepository, FILES_COLLECTION } from "@/modules/files-storage/repository.js";
import { FileService } from "@/modules/files-storage/service.js";
import type { FileObject } from "@/modules/files-storage/types.js";
import { PdfService, type PdfDocumentType } from "@/modules/pdf-generation/service.js";
import { renderPreviewHtml, renderDraftPreviewHtml, type DraftPreviewPayload } from "@/modules/pdf-generation/preview.js";

/**
 * PDF-generation routes. Two additive endpoints:
 *
 *   GET /api/v1/invoices/:id/pdf
 *   GET /api/v1/quotes/:id/pdf
 *
 * Contract (return-if-exists, else enqueue):
 *   - if a stored PDF FileObject already exists (ownerType invoice/quote,
 *     ownerId = the doc id, contentType application/pdf, scan clean) → 200 with a
 *     short-TTL **presigned download URL** (reuses files-storage `requestDownload`,
 *     which keeps the authorize + scan-gate).
 *   - else → enqueue a `pdf` job (worker renders + stores) and return **202
 *     Accepted** with the job ref. The frontend polls the same endpoint until the
 *     file exists.
 *
 * The API NEVER renders (no Playwright in api) — it only enqueues.
 *
 * DEPS NOTE (integrator): unlike the pinned `{ db, emitter, logger, minio }`
 * ModuleDeps, this factory ALSO needs a `QueueRegistry` (to enqueue). The
 * registry currently threads no queue, so wiring requires constructing/threading
 * one — see the module report.
 */

export interface PdfGenerationDeps {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
  minio: MinioConn;
  queue: QueueRegistry;
}

/** application/pdf content-type the worker writes and this route matches on. */
const PDF_CONTENT_TYPE = "application/pdf";

export const mountPdfGeneration = (deps: PdfGenerationDeps): Router<AppState> => {
  const fileRepo = new FileObjectRepository(deps.db.collection<FileObject>(FILES_COLLECTION));
  const fileService = new FileService({
    repo: fileRepo,
    emitter: deps.emitter,
    logger: deps.logger,
    minio: deps.minio,
  });
  const pdfService = new PdfService(deps.queue);

  // No shared prefix — the two document families live under different roots.
  const r = new Router<AppState>();
  r.use(requireAuth);

  const handle = (ownerType: PdfDocumentType) => async (ctx: Context) => {
    const authCtx = (ctx as unknown as { state: AppState }).state.authContext!;
    const docId = (ctx as unknown as { params: { id?: string } }).params.id!;

    // Look for an already-rendered PDF for this document (most-recent first).
    const { items } = await fileService.list(authCtx, {
      ownerType,
      ownerId: docId,
      contentType: PDF_CONTENT_TYPE,
      sort: "-createdAt",
      limit: "1",
    });
    const existing = items.find((f) => f.contentType === PDF_CONTENT_TYPE && f.ownerId === docId);

    if (existing && existing.scanStatus === "clean") {
      // Same-origin streaming URL (NOT a MinIO presigned URL — that's signed for the
      // object store's internal Docker host, unreachable from the user's browser).
      // The /content route re-applies the authorize + scan-gate.
      const downloadUrl = `/api/v1/files/${existing.id}/content`;
      ctx.status = 200;
      ctx.body = successEnvelope({ status: "ready", fileId: existing.id, downloadUrl }, {});
      return;
    }

    // No stored PDF yet → enqueue a render and tell the caller to poll (202).
    const { jobId } = await pdfService.enqueue(authCtx, ownerType, docId);
    ctx.status = 202;
    ctx.body = successEnvelope({ status: "pending", documentType: ownerType, documentId: docId, jobId }, {});
  };

  /**
   * HTML PREVIEW — PURE render via the template.ts builders (NO
   * Playwright in the api). Loads the source doc + assembles the branding
   * view (mirroring the worker's fetchBranding, see preview.ts) and returns the
   * rendered HTML in the success envelope: `{ html }`. 404 when the doc is missing.
   * The company logo is resolved to a base64 data URI (via `deps.minio`), matching
   * the worker's PDF render path.
   */
  const preview = (ownerType: PdfDocumentType) => async (ctx: Context) => {
    const docId = (ctx as unknown as { params: { id?: string } }).params.id!;
    const auth = (ctx as unknown as { state: { authContext?: { accountId: string } } }).state.authContext;
    if (!auth) throw errors.notFound(`${ownerType} not found`);
    const html = await renderPreviewHtml(deps.db, ownerType, docId, auth.accountId, deps.minio);
    if (html === null) throw errors.notFound(`${ownerType} not found`);
    ctx.status = 200;
    ctx.body = successEnvelope({ html }, {});
  };

  // typePath per type: invoice→invoices, quote→quotes,
  // proforma→proforma, credit-note→credit-notes, contract→contracts.
  r.get("/api/v1/invoices/:id/pdf", handle("invoice"));
  r.get("/api/v1/quotes/:id/pdf", handle("quote"));
  r.get("/api/v1/proforma/:id/pdf", handle("proforma"));
  r.get("/api/v1/credit-notes/:id/pdf", handle("credit-note"));
  r.get("/api/v1/contracts/:id/pdf", handle("contract"));

  r.get("/api/v1/invoices/:id/preview", preview("invoice"));
  r.get("/api/v1/quotes/:id/preview", preview("quote"));
  r.get("/api/v1/proforma/:id/preview", preview("proforma"));
  r.get("/api/v1/credit-notes/:id/preview", preview("credit-note"));
  r.get("/api/v1/contracts/:id/preview", preview("contract"));

  // LIVE preview of an UNSAVED draft: the create-form POSTs its current payload
  // and gets back the rendered HTML — no persistence. Totals are recomputed
  // server-side; the recipient snapshot is read from the chosen client.
  const draftPreview = (ownerType: PdfDocumentType) => async (ctx: Context) => {
    const auth = (ctx as unknown as { state: { authContext?: { accountId: string } } }).state.authContext;
    if (!auth) throw errors.unauthenticated();
    const payload = ((ctx as unknown as { request: { body?: unknown } }).request.body ?? {}) as DraftPreviewPayload;
    const html = await renderDraftPreviewHtml(deps.db, ownerType, auth.accountId, payload, deps.minio);
    ctx.status = 200;
    ctx.body = successEnvelope({ html }, {});
  };
  r.post("/api/v1/invoices/preview-draft", draftPreview("invoice"));
  r.post("/api/v1/quotes/preview-draft", draftPreview("quote"));
  r.post("/api/v1/proforma/preview-draft", draftPreview("proforma"));
  r.post("/api/v1/credit-notes/preview-draft", draftPreview("credit-note"));

  return r;
};
