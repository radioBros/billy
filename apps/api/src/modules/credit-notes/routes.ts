import Router from "@koa/router";
import type { Db } from "mongodb";
import { errors, type Logger } from "@billy/shared";
import type { AuthContext } from "@billy/types";
import type { AppState } from "@/app.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import { validate } from "@/platform/validate.js";
import { canSeeFinancials, respondCreated, respondList, respondOk } from "@/platform/serializer.js";
import { formatDocumentNumber, nextSequence, type Counter } from "@/platform/numbering.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import { CreditNoteRepository, CREDIT_NOTES_COLLECTION } from "@/modules/credit-notes/repository.js";
import { CreditNoteService, type ClientRecord } from "@/modules/credit-notes/service.js";
import { CreditNoteCreateSchema, CreditNoteUpdateSchema } from "@/modules/credit-notes/schema.js";
import type { CreditNote } from "@/modules/credit-notes/types.js";

export const createCreditNotesRouter = (deps: {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
}): Router<AppState> => {
  const repo = new CreditNoteRepository(deps.db.collection<CreditNote>(CREDIT_NOTES_COLLECTION));
  const counters = deps.db.collection<Counter>("counters");
  const clients = deps.db.collection("clients");

  const service = new CreditNoteService({
    repo,
    emitter: deps.emitter,
    logger: deps.logger,
    // issue reads the clients collection to build the snapshot (mirrors invoices).
    loadClient: async (ctx, clientId): Promise<ClientRecord | null> => {
      const c = (await clients.findOne(
        { id: clientId, accountId: ctx.accountId, deletedAt: null },
        { projection: { _id: 0 } },
      )) as (ClientRecord & { accountId?: string }) | null;
      if (c) return c;
      return (await clients.findOne(
        { id: clientId, deletedAt: null },
        { projection: { _id: 0 } },
      )) as ClientRecord | null;
    },
    // Atomic CN-<year>-#### allocation (numbering.ts): its own `credit-note` series,
    // independent of the invoice/quote series.
    nextCreditNoteNumber: async (accountId, year): Promise<string> => {
      const seq = await nextSequence(counters, accountId, `credit-note-${year}`);
      return formatDocumentNumber({ prefix: "CN", seq, padding: 4, year, style: "slashYear" });
    },
  });

  const r = new Router<AppState>({ prefix: "/api/v1/credit-notes" });
  r.use(requireAuth);

  // GET /api/v1/credit-notes — list
  r.get("/", async (ctx) => {
    const auth = ctx.state.authContext!;
    const { items, meta } = await service.list(auth, ctx.query);
    respondList(ctx, items.map((c) => stripCreditNoteFinancial(auth, c)), meta);
  });

  // GET /api/v1/credit-notes/:id
  r.get("/:id", async (ctx) => {
    const auth = ctx.state.authContext!;
    const cn = await service.get(auth, ctx.params.id!);
    respondOk(ctx, stripCreditNoteFinancial(auth, cn));
  });

  // POST /api/v1/credit-notes — create draft
  r.post("/", async (ctx) => {
    const auth = ctx.state.authContext!;
    const input = validate(CreditNoteCreateSchema, ctx.request.body);
    const created = await service.create(auth, input);
    respondCreated(ctx, stripCreditNoteFinancial(auth, created));
  });

  // PATCH /api/v1/credit-notes/:id — versioned draft update
  r.patch("/:id", async (ctx) => {
    const auth = ctx.state.authContext!;
    const input = validate(CreditNoteUpdateSchema, ctx.request.body);
    const version = resolveVersion(ctx.get("if-match"), input.version);
    const updated = await service.update(auth, ctx.params.id!, version, input);
    respondOk(ctx, stripCreditNoteFinancial(auth, updated));
  });

  // DELETE /api/v1/credit-notes/:id — soft-delete (capability-gated in the service)
  r.delete("/:id", async (ctx) => {
    const auth = ctx.state.authContext!;
    await service.softDelete(auth, ctx.params.id!);
    respondOk(ctx, { ok: true });
  });

  // POST /api/v1/credit-notes/:id/archive
  r.post("/:id/archive", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const archived = await service.archive(auth, ctx.params.id!, version);
    respondOk(ctx, stripCreditNoteFinancial(auth, archived));
  });

  // POST /api/v1/credit-notes/:id/restore
  r.post("/:id/restore", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const restored = await service.restore(auth, ctx.params.id!, version);
    respondOk(ctx, stripCreditNoteFinancial(auth, restored));
  });

  // POST /api/v1/credit-notes/:id/issue — assign CN- number + snapshot + lock
  r.post("/:id/issue", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const issued = await service.issue(auth, ctx.params.id!, version);
    respondOk(ctx, stripCreditNoteFinancial(auth, issued));
  });

  // POST /api/v1/credit-notes/:id/void
  r.post("/:id/void", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const voided = await service.void(auth, ctx.params.id!, version);
    respondOk(ctx, stripCreditNoteFinancial(auth, voided));
  });

  return r;
};

/** Top-level money fields removed for non-financial callers. */
const CN_MONEY_FIELDS = ["subtotalMinor", "discountMinor", "taxMinor", "grandTotalMinor"] as const;
const LINE_MONEY_FIELDS = ["unitPriceMinor", "lineSubtotalMinor", "lineDiscountMinor", "lineTaxMinor", "lineTotalMinor"];

export const stripCreditNoteFinancial = (ctx: AuthContext, cn: CreditNote): CreditNote => {
  if (canSeeFinancials(ctx)) return cn;
  const copy = { ...cn } as Record<string, unknown>;
  for (const f of CN_MONEY_FIELDS) delete copy[f];
  if (Array.isArray(cn.lineItems)) {
    copy.lineItems = cn.lineItems.map((li) => {
      const l = { ...(li as unknown as Record<string, unknown>) };
      for (const f of LINE_MONEY_FIELDS) delete l[f];
      return l;
    });
  }
  return copy as unknown as CreditNote;
};

const bodyVersion = (body: unknown): number | undefined => {
  if (body && typeof body === "object" && "version" in body) {
    const v = (body as { version?: unknown }).version;
    if (typeof v === "number") return v;
  }
  return undefined;
};

const resolveVersion = (ifMatch: string | undefined, bodyVal: number | undefined): number => {
  const header = ifMatch?.trim().replace(/^"(.*)"$/u, "$1");
  if (header && /^\d+$/u.test(header)) return Number(header);
  if (typeof bodyVal === "number" && Number.isInteger(bodyVal) && bodyVal >= 0) return bodyVal;
  throw errors.validation("Missing or invalid version (If-Match header or body `version` required)", {
    version: "field.required",
  });
};
