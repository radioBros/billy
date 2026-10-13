import Router from "@koa/router";
import type { Db } from "mongodb";
import { AppError, type Logger } from "@billy/shared";
import { verifyPassoWebhook, type DocKind } from "@billy/einvoice";
import type { AppState } from "@/app.js";
import type { QueueRegistry } from "@/platform/queue.js";
import { validate } from "@/platform/validate.js";
import { respondOk } from "@/platform/serializer.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import { EInvoicingService } from "@/modules/einvoicing/service.js";
import { ChannelUpdateSchema, DocFlagSchema, OpenapiTestSchema, PecTestSchema, EInvoicingSettingsUpdateSchema } from "@/modules/einvoicing/schema.js";

const KINDS: Record<string, DocKind> = { invoices: "invoice", "credit-notes": "credit_note" };
const kindOf = (param: string | undefined): DocKind => {
  const k = param ? KINDS[param] : undefined;
  if (!k) throw new AppError("RESOURCE_NOT_FOUND", "Unknown document type");
  return k;
};

export const createEInvoicingRouters = (deps: { db: Db; logger: Logger; queue?: QueueRegistry }): { authed: Router<AppState>; hook: Router<AppState> } => {
  const service = new EInvoicingService({ db: deps.db, logger: deps.logger, ...(deps.queue ? { queue: deps.queue } : {}) });

  // ── Authenticated surface ──────────────────────────────────────────────────
  const r = new Router<AppState>({ prefix: "/api/v1" });
  r.use(requireAuth);

  r.get("/settings/einvoicing", async (ctx) => respondOk(ctx, await service.view(ctx.state.authContext!)));
  r.patch("/settings/einvoicing", async (ctx) => {
    const input = validate(EInvoicingSettingsUpdateSchema, ctx.request.body);
    respondOk(ctx, await service.update(ctx.state.authContext!, input));
  });
  r.post("/settings/einvoicing/provision", async (ctx) => respondOk(ctx, await service.provision(ctx.state.authContext!)));
  r.post("/settings/einvoicing/reset", async (ctx) => respondOk(ctx, await service.reset(ctx.state.authContext!)));
  r.put("/settings/einvoicing/channel", async (ctx) => {
    const input = validate(ChannelUpdateSchema, ctx.request.body);
    respondOk(ctx, await service.putChannel(ctx.state.authContext!, input));
  });
  r.post("/settings/einvoicing/channel/test", async (ctx) => {
    const input = validate(PecTestSchema, ctx.request.body);
    respondOk(ctx, await service.testPec(ctx.state.authContext!, input));
  });
  r.post("/settings/einvoicing/channel/test-openapi", async (ctx) => {
    const input = validate(OpenapiTestSchema, ctx.request.body);
    respondOk(ctx, await service.testOpenapi(ctx.state.authContext!, input));
  });
  r.post("/settings/einvoicing/test", async (ctx) => respondOk(ctx, await service.test(ctx.state.authContext!)));

  r.get("/einvoicing/summary", async (ctx) => respondOk(ctx, await service.summary(ctx.state.authContext!)));

  r.get("/:kind(invoices|credit-notes)/:id/einvoice", async (ctx) =>
    respondOk(ctx, await service.state(ctx.state.authContext!, kindOf(ctx.params.kind), ctx.params.id!)),
  );
  r.post("/:kind(invoices|credit-notes)/:id/einvoice/preflight", async (ctx) =>
    respondOk(ctx, await service.preflight(ctx.state.authContext!, kindOf(ctx.params.kind), ctx.params.id!)),
  );
  r.post("/:kind(invoices|credit-notes)/:id/einvoice/submit", async (ctx) => {
    const out = await service.submit(ctx.state.authContext!, kindOf(ctx.params.kind), ctx.params.id!);
    respondOk(ctx, out);
    ctx.status = 202;
  });
  r.post("/:kind(invoices|credit-notes)/:id/einvoice/retry", async (ctx) => {
    const out = await service.retry(ctx.state.authContext!, kindOf(ctx.params.kind), ctx.params.id!);
    respondOk(ctx, out);
    ctx.status = 202;
  });
  r.patch("/invoices/:id/einvoice", async (ctx) => {
    const { submitOnFinalize } = validate(DocFlagSchema, ctx.request.body);
    respondOk(ctx, await service.setSubmitOnFinalize(ctx.state.authContext!, ctx.params.id!, submitOnFinalize));
  });
  r.get("/:kind(invoices|credit-notes)/:id/einvoice/xml", async (ctx) => {
    const { xml, fileName } = await service.xml(ctx.state.authContext!, kindOf(ctx.params.kind), ctx.params.id!);
    ctx.type = "application/xml";
    ctx.set("content-disposition", `attachment; filename="${fileName.replace(/[^\w.\-]/gu, "_")}"`);
    ctx.body = xml;
  });
  r.get("/:kind(invoices|credit-notes)/:id/einvoice/rendered", async (ctx) => {
    ctx.type = "text/html";
    // The page is the tax authority's own stylesheet output; sandbox it hard.
    ctx.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    ctx.body = await service.rendered(ctx.state.authContext!, kindOf(ctx.params.kind), ctx.params.id!);
  });

  // ── Public webhook (PASSO → billy). Accelerator only: polling is the source of truth. ──
  // Unauthenticated by session; the HMAC over the RAW body is the sole credential, with the
  // account taken from the path so the right per-account secret is chosen BEFORE parsing.
  const hook = new Router<AppState>({ prefix: "/public/einvoice" });
  hook.post("/passo/:accountId", async (ctx) => {
    const accountId = ctx.params.accountId!;
    const raw = (ctx.request as unknown as { rawBody?: string }).rawBody ?? "";
    const secret = await service.webhookSecret(accountId);
    // Same answer for "no such account / no secret / bad signature" — no enumeration.
    const verdict = secret ? verifyPassoWebhook(ctx.get("x-passo-signature") || undefined, raw, secret) : "bad_signature";
    if (verdict !== "ok") {
      deps.logger.warn({ accountId, verdict }, "einvoice webhook rejected");
      throw new AppError("UNAUTHENTICATED", "Invalid signature");
    }
    let submissionId: string | undefined;
    try {
      submissionId = (JSON.parse(raw) as { data?: { submissionId?: string } }).data?.submissionId;
    } catch {
      /* body shape is only a hint */
    }
    await service.onWebhook(accountId, submissionId);
    ctx.status = 200;
    ctx.body = { received: true };
  });

  return { authed: r, hook };
};
