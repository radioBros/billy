import Router from "@koa/router";
import type { Db } from "mongodb";
import { errors, type Logger } from "@billy/shared";
import type { AppState } from "@/app.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import { ExportService } from "@/modules/import-export/service.js";
import type { ExportFormat } from "@/modules/import-export/types.js";

export const createImportExportRouter = (deps: {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
}): Router<AppState> => {
  const service = new ExportService({ db: deps.db, emitter: deps.emitter, logger: deps.logger });

  const r = new Router<AppState>({ prefix: "/api/v1" });

  r.use(requireAuth);

 // POST /api/v1/exports/:resource — sync CSV/JSON export (canExportData gated).
 // Returns the RAW file body (not the success envelope) with download headers.
  r.post("/exports/:resource", async (ctx) => {
    const format = parseFormat(ctx.request.body);
    const result = await service.export(ctx.state.authContext!, ctx.params.resource!, format);

    ctx.status = 200;
    ctx.type = result.contentType;
    ctx.set("Content-Disposition", `attachment; filename="${result.filename}"`);
    ctx.body = result.body;
  });

 // POST /api/v1/imports/:resource — DEFERRED. The staged, previewable import
 // pipeline (parse→map→validate→dedup→dry-run→commit) is a
 // follow-up. Respond 501 with a PLAIN body — there is no NOT_IMPLEMENTED error
 // code, and pairing 501 with a registry-bound `code` (all 500/503-class) would
 // lie in the envelope, so we emit no canonical `error` object here.
  r.post("/imports/:resource", (ctx) => {
    ctx.status = 501;
    ctx.body = { message: "Import is not yet implemented." };
  });

  return r;
};

const parseFormat = (body: unknown): ExportFormat => {
  if (body && typeof body === "object" && "format" in body) {
    const f = (body as { format?: unknown }).format;
    if (f === "csv" || f === "json") return f;
    if (f !== undefined) {
      throw errors.validation("Unsupported export format (expected 'csv' or 'json')", {
        format: "field.unsupported",
      });
    }
  }
  return "csv";
};
