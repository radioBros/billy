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
import { ProformaRepository, PROFORMAS_COLLECTION } from "@/modules/proforma/repository.js";
import { ProformaService, type ClientRecord } from "@/modules/proforma/service.js";
import { ProformaCreateSchema, ProformaUpdateSchema } from "@/modules/proforma/schema.js";
import type { Proforma } from "@/modules/proforma/types.js";
import {
  InvoiceRepository,
  INVOICES_COLLECTION,
  InvoiceService,
  stripInvoiceFinancial,
  type BankAccountRecord,
  type ClientRecord as InvoiceClientRecord,
  type Invoice,
} from "@/modules/invoices/index.js";

export const createProformaRouter = (deps: {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
}): Router<AppState> => {
  const repo = new ProformaRepository(deps.db.collection<Proforma>(PROFORMAS_COLLECTION));
  const counters = deps.db.collection<Counter>("counters");
  const clients = deps.db.collection("clients");
  const settings = deps.db.collection("settings");

  /** Shared client loader (mirrors invoices): scoped match, falling back to unscoped. */
  const loadClient = async (ctx: AuthContext, clientId: string): Promise<ClientRecord | null> => {
    const c = (await clients.findOne(
      { id: clientId, accountId: ctx.accountId, deletedAt: null },
      { projection: { _id: 0 } },
    )) as (ClientRecord & { accountId?: string }) | null;
    if (c) return c;
    return (await clients.findOne(
      { id: clientId, deletedAt: null },
      { projection: { _id: 0 } },
    )) as ClientRecord | null;
  };

  // ── Invoice-minting seam (convert) ────────────────────────────────────────────
  // The convert action crosses proforma→invoices. We compose a minimal InvoiceService
  // here (per the per-module factory pattern) and inject the mint + loadInvoice ports
  // into ProformaService — registry.ts stays untouched. Only `create`/`get` are used;
  // the other deps (numbering, bank) reuse the invoices module's own wiring.
  const invoiceRepo = new InvoiceRepository(deps.db.collection<Invoice>(INVOICES_COLLECTION));
  const invoiceService = new InvoiceService({
    repo: invoiceRepo,
    emitter: deps.emitter,
    logger: deps.logger,
    loadClient: loadClient as (ctx: AuthContext, id: string) => Promise<InvoiceClientRecord | null>,
    nextInvoiceNumber: async (accountId, year): Promise<string> => {
      const seq = await nextSequence(counters, accountId, `invoice-${year}`);
      return formatDocumentNumber({ prefix: "INV", seq, padding: 4, year, style: "slashYear" });
    },
    loadBankAccounts: async (): Promise<BankAccountRecord[]> => {
      const doc = (await settings.findOne(
        { key: "business" },
        { projection: { _id: 0, "data.bankAccounts": 1 } },
      )) as { data?: { bankAccounts?: BankAccountRecord[] } } | null;
      return doc?.data?.bankAccounts ?? [];
    },
  });

  const service = new ProformaService({
    repo,
    emitter: deps.emitter,
    logger: deps.logger,
    // issue reads the clients collection to build the snapshot (mirrors invoices).
    loadClient,
    // Atomic PRO-<year>-#### allocation (numbering.ts): its own `proforma` series,
    // independent of the invoice/quote/credit-note series.
    nextProformaNumber: async (accountId, year): Promise<string> => {
      const seq = await nextSequence(counters, accountId, `proforma-${year}`);
      return formatDocumentNumber({ prefix: "PRO", seq, padding: 4, year, style: "slashYear" });
    },
    // Mint a DRAFT invoice from the proforma via InvoiceService.create. The invoice
    // starts today with a due date = issueDate (draft; re-snapshots client at finalize).
    mintInvoiceFromProforma: async (ctx, data): Promise<Invoice> => {
      const today = new Date().toISOString().slice(0, 10);
      return invoiceService.create(ctx, {
        clientId: data.clientId,
        currency: data.currency,
        issueDate: today,
        dueDate: today,
        lineItems: data.lineItems,
        notes: data.notes ?? null,
      });
    },
    // Idempotent-replay loader: return the already-minted invoice without re-minting.
    loadInvoice: async (ctx, invoiceId): Promise<Invoice | null> => invoiceService.get(ctx, invoiceId),
  });

  const r = new Router<AppState>({ prefix: "/api/v1/proformas" });
  r.use(requireAuth);

  // GET /api/v1/proformas — list
  r.get("/", async (ctx) => {
    const auth = ctx.state.authContext!;
    const { items, meta } = await service.list(auth, ctx.query);
    respondList(ctx, items.map((p) => stripProformaFinancial(auth, p)), meta);
  });

  // GET /api/v1/proformas/:id
  r.get("/:id", async (ctx) => {
    const auth = ctx.state.authContext!;
    const p = await service.get(auth, ctx.params.id!);
    respondOk(ctx, stripProformaFinancial(auth, p));
  });

  // POST /api/v1/proformas — create draft
  r.post("/", async (ctx) => {
    const auth = ctx.state.authContext!;
    const input = validate(ProformaCreateSchema, ctx.request.body);
    const created = await service.create(auth, input);
    respondCreated(ctx, stripProformaFinancial(auth, created));
  });

  // PATCH /api/v1/proformas/:id — versioned draft update
  r.patch("/:id", async (ctx) => {
    const auth = ctx.state.authContext!;
    const input = validate(ProformaUpdateSchema, ctx.request.body);
    const version = resolveVersion(ctx.get("if-match"), input.version);
    const updated = await service.update(auth, ctx.params.id!, version, input);
    respondOk(ctx, stripProformaFinancial(auth, updated));
  });

  // DELETE /api/v1/proformas/:id — soft-delete (capability-gated in the service)
  r.delete("/:id", async (ctx) => {
    const auth = ctx.state.authContext!;
    await service.softDelete(auth, ctx.params.id!);
    respondOk(ctx, { ok: true });
  });

  // POST /api/v1/proformas/:id/archive
  r.post("/:id/archive", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const archived = await service.archive(auth, ctx.params.id!, version);
    respondOk(ctx, stripProformaFinancial(auth, archived));
  });

  // POST /api/v1/proformas/:id/restore
  r.post("/:id/restore", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const restored = await service.restore(auth, ctx.params.id!, version);
    respondOk(ctx, stripProformaFinancial(auth, restored));
  });

  // POST /api/v1/proformas/:id/issue — assign PRO- number + snapshot + lock
  r.post("/:id/issue", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const issued = await service.issue(auth, ctx.params.id!, version);
    respondOk(ctx, stripProformaFinancial(auth, issued));
  });

  // POST /api/v1/proformas/:id/void
  r.post("/:id/void", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const voided = await service.void(auth, ctx.params.id!, version);
    respondOk(ctx, stripProformaFinancial(auth, voided));
  });

  // POST /api/v1/proformas/:id/convert — mint a DRAFT invoice from an issued proforma
  // (idempotent). Returns the new/existing INVOICE (financially stripped),
  // NOT the proforma — the frontend navigates to the new draft.
  r.post("/:id/convert", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const { invoice } = await service.convert(auth, ctx.params.id!, version);
    respondCreated(ctx, stripInvoiceFinancial(auth, invoice as Invoice));
  });

  return r;
};

/** Top-level money fields removed for non-financial callers. */
const PRO_MONEY_FIELDS = ["subtotalMinor", "discountMinor", "taxMinor", "grandTotalMinor"] as const;
const LINE_MONEY_FIELDS = ["unitPriceMinor", "lineSubtotalMinor", "lineDiscountMinor", "lineTaxMinor", "lineTotalMinor"];

export const stripProformaFinancial = (ctx: AuthContext, p: Proforma): Proforma => {
  if (canSeeFinancials(ctx)) return p;
  const copy = { ...p } as Record<string, unknown>;
  for (const f of PRO_MONEY_FIELDS) delete copy[f];
  if (Array.isArray(p.lineItems)) {
    copy.lineItems = p.lineItems.map((li) => {
      const l = { ...(li as unknown as Record<string, unknown>) };
      for (const f of LINE_MONEY_FIELDS) delete l[f];
      return l;
    });
  }
  return copy as unknown as Proforma;
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
