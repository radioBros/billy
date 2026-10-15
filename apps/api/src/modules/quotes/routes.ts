import Router from "@koa/router";
import type { Db } from "mongodb";
import { errors, type Logger } from "@billy/shared";
import { todayInZone } from "@billy/einvoice";
import type { AuthContext } from "@billy/types";
import type { AppState } from "@/app.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import { validate } from "@/platform/validate.js";
import { canSeeFinancials, respondCreated, respondList, respondOk, stripFinancial } from "@/platform/serializer.js";
import { formatDocumentNumber, nextSequence, type Counter } from "@/platform/numbering.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import { QuoteRepository, QUOTES_COLLECTION } from "@/modules/quotes/repository.js";
import { QuoteService, type QuoteInvoicePorts } from "@/modules/quotes/service.js";
import { QuoteCreateSchema, QuoteUpdateSchema } from "@/modules/quotes/schema.js";
import type { ConvertedInvoiceRef, Quote } from "@/modules/quotes/types.js";
import {
  InvoiceRepository,
  INVOICES_COLLECTION,
  InvoiceService,
  type BankAccountRecord,
  type ClientRecord as InvoiceClientRecord,
  type CreateFromQuoteInput,
  type Invoice,
} from "@/modules/invoices/index.js";
import { EmailService } from "@/modules/email/service.js";
import { ShareTokenStore } from "@/modules/public-links/share-tokens.js";
import type { QueueRegistry } from "@/platform/queue.js";

/**
 * `/api/v1/quotes/*` routes. Thin controllers:
 * marshal ctx ↔ service, validate, serialize the envelope — no domain branching.
 * Every route is behind `requireAuth`; the service receives the request
 * `authContext` on every call. Financial fields (doc totals + per-line money) are
 * stripped from responses when the caller lacks `canViewFinancialTotals`.
 *
 * The no-auth `/public/quotes/:token` surface is handled elsewhere —
 * NOT built here; this module only mints/revokes/stores the token.
 */

/** Top-level financial fields removed when the caller cannot view totals. */
const QUOTE_FINANCIAL_FIELDS = ["subtotalMinor", "discountMinor", "taxMinor", "grandTotalMinor"] as const;
const LINE_FINANCIAL_FIELDS = ["lineSubtotalMinor", "lineDiscountMinor", "lineTaxMinor", "lineTotalMinor"] as const;

const serializeQuote = (ctx: AuthContext, quote: Quote): Quote => {
  const stripped = stripFinancial(ctx, quote, QUOTE_FINANCIAL_FIELDS);
  if (canSeeFinancials(ctx) || !Array.isArray(stripped.lineItems)) return stripped;
  return {
    ...stripped,
    lineItems: stripped.lineItems.map((line) => {
      const copy = { ...(line as unknown as Record<string, unknown>) };
      for (const f of LINE_FINANCIAL_FIELDS) delete copy[f];
      return copy as unknown as (typeof stripped.lineItems)[number];
    }),
  };
};

const serializeQuoteList = (ctx: AuthContext, quotes: readonly Quote[]): Quote[] => {
  return quotes.map((q) => serializeQuote(ctx, q));
};

export const createQuotesRouter = (deps: {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
  queue?: QueueRegistry;
}): Router<AppState> => {
  const repo = new QuoteRepository(deps.db.collection<Quote>(QUOTES_COLLECTION));
  // When a job queue is available, wire the transactional emailer so `/send`
  // emails the client (best-effort, in the client's locale). Absent in tests.
  const emailer = deps.queue ? new EmailService({ queue: deps.queue, logger: deps.logger }) : undefined;
  const shareTokens = new ShareTokenStore(deps.db);

  // ── Invoice seam (convert) ──────────────────────────────────────────────────
  // Convert creates the draft invoice server-side. We compose an InvoiceService
  // here (same per-module factory pattern as proforma/routes.ts) and hand the
  // quote service narrow ports — strictly account-scoped reads throughout.
  const clients = deps.db.collection("clients");
  const settings = deps.db.collection("settings");
  const counters = deps.db.collection<Counter>("counters");
  const invoicesCol = deps.db.collection<Invoice>(INVOICES_COLLECTION);
  const invoiceRepo = new InvoiceRepository(invoicesCol);
  const invoiceService = new InvoiceService({
    repo: invoiceRepo,
    emitter: deps.emitter,
    logger: deps.logger,
    loadClient: async (ctx, clientId): Promise<InvoiceClientRecord | null> =>
      (await clients.findOne(
        { id: clientId, accountId: ctx.accountId, deletedAt: null },
        { projection: { _id: 0 } },
      )) as InvoiceClientRecord | null,
    nextInvoiceNumber: async (accountId, year): Promise<string> => {
      const seq = await nextSequence(counters, accountId, `invoice-${year}`);
      return formatDocumentNumber({ prefix: "INV", seq, padding: 4, year, style: "slashYear" });
    },
    loadBankAccounts: async (ctx): Promise<BankAccountRecord[]> => {
      const doc = (await settings.findOne(
        { key: "business", accountId: ctx.accountId },
        { projection: { _id: 0, "data.bankAccounts": 1 } },
      )) as { data?: { bankAccounts?: BankAccountRecord[] } } | null;
      return doc?.data?.bankAccounts ?? [];
    },
    // "Today" in THIS account's business timezone (default Europe/Rome) — the
    // converted invoice's issue date; same helper as invoices/routes.ts.
    todayFor: async (ctx): Promise<string> => {
      const doc = (await settings.findOne(
        { key: "business", accountId: ctx.accountId },
        { projection: { _id: 0, "data.timezone": 1 } },
      )) as { data?: { timezone?: string | null } } | null;
      return todayInZone(doc?.data?.timezone || "Europe/Rome");
    },
  });
  const toRef = (inv: Pick<Invoice, "id" | "invoiceNumber" | "status">): ConvertedInvoiceRef => ({
    id: inv.id,
    invoiceNumber: inv.invoiceNumber ?? null,
    status: inv.status,
  });
  const invoicePorts: QuoteInvoicePorts = {
    createInvoiceFromQuote: async (ctx, payload) => {
      // Typed variable (not an inline literal): it also carries subject/projectId.
      const input: CreateFromQuoteInput = payload;
      return toRef(await invoiceService.createFromQuote(ctx, input));
    },
    findInvoiceForQuote: async (ctx, quoteId) => {
      const inv = (await invoicesCol.findOne(
        { accountId: ctx.accountId, convertedFromQuoteId: quoteId, deletedAt: null, status: { $ne: "void" } } as never,
        { projection: { _id: 0, id: 1, invoiceNumber: 1, status: 1 } },
      )) as Pick<Invoice, "id" | "invoiceNumber" | "status"> | null;
      return inv ? toRef(inv) : null;
    },
    // A just-created, never-finalized draft (no number burned) → soft-delete it.
    discardInvoice: async (ctx, invoiceId) => invoiceRepo.softDelete(ctx, invoiceId),
  };

  const service = new QuoteService({
    repo,
    emitter: deps.emitter,
    logger: deps.logger,
    db: deps.db,
    emailer,
    shareTokens,
    invoices: invoicePorts,
  });

  const r = new Router<AppState>({ prefix: "/api/v1/quotes" });

  r.use(requireAuth);

  // GET /api/v1/quotes — list
  r.get("/", async (ctx) => {
    const auth = ctx.state.authContext!;
    const { items, meta } = await service.list(auth, ctx.query);
    respondList(ctx, serializeQuoteList(auth, items), meta);
  });

  // GET /api/v1/quotes/:id
  r.get("/:id", async (ctx) => {
    const auth = ctx.state.authContext!;
    const quote = await service.get(auth, ctx.params.id!);
    respondOk(ctx, serializeQuote(auth, quote));
  });

  // POST /api/v1/quotes — create
  r.post("/", async (ctx) => {
    const auth = ctx.state.authContext!;
    const input = validate(QuoteCreateSchema, ctx.request.body);
    const created = await service.create(auth, input);
    respondCreated(ctx, serializeQuote(auth, created));
  });

  // PATCH /api/v1/quotes/:id — versioned update
  r.patch("/:id", async (ctx) => {
    const auth = ctx.state.authContext!;
    const input = validate(QuoteUpdateSchema, ctx.request.body);
    const expectedVersion = resolveVersion(ctx.get("if-match"), input.version);
    const updated = await service.update(auth, ctx.params.id!, expectedVersion, input);
    respondOk(ctx, serializeQuote(auth, updated));
  });

  // DELETE /api/v1/quotes/:id — soft-delete (capability-gated in the service)
  r.delete("/:id", async (ctx) => {
    await service.softDelete(ctx.state.authContext!, ctx.params.id!);
    respondOk(ctx, { ok: true });
  });

  // POST /api/v1/quotes/:id/archive — versioned archive
  r.post("/:id/archive", async (ctx) => {
    const auth = ctx.state.authContext!;
    const expectedVersion = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const archived = await service.archive(auth, ctx.params.id!, expectedVersion);
    respondOk(ctx, serializeQuote(auth, archived));
  });

  // POST /api/v1/quotes/:id/restore — versioned restore
  r.post("/:id/restore", async (ctx) => {
    const auth = ctx.state.authContext!;
    const expectedVersion = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const restored = await service.restore(auth, ctx.params.id!, expectedVersion);
    respondOk(ctx, serializeQuote(auth, restored));
  });

  // POST /api/v1/quotes/:id/send — draft → sent (snapshot + numbering)
  r.post("/:id/send", async (ctx) => {
    const auth = ctx.state.authContext!;
    const expectedVersion = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const sent = await service.send(auth, ctx.params.id!, expectedVersion);
    respondOk(ctx, serializeQuote(auth, sent));
  });

  // POST /api/v1/quotes/:id/accept — sent → accepted
  r.post("/:id/accept", async (ctx) => {
    const auth = ctx.state.authContext!;
    const expectedVersion = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const accepted = await service.accept(auth, ctx.params.id!, expectedVersion);
    respondOk(ctx, serializeQuote(auth, accepted));
  });

  // POST /api/v1/quotes/:id/decline — sent → declined
  r.post("/:id/decline", async (ctx) => {
    const auth = ctx.state.authContext!;
    const expectedVersion = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const declined = await service.decline(auth, ctx.params.id!, expectedVersion);
    respondOk(ctx, serializeQuote(auth, declined));
  });

  // POST /api/v1/quotes/:id/convert — accepted → converted. Creates the DRAFT
  // invoice server-side and links it, in one request. Returns the updated quote
  // plus the new invoice's id/number/status (no money — nothing to strip).
  r.post("/:id/convert", async (ctx) => {
    const auth = ctx.state.authContext!;
    const expectedVersion = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const { quote, invoice } = await service.convert(auth, ctx.params.id!, expectedVersion);
    respondOk(ctx, { quote: serializeQuote(auth, quote), invoice });
  });

  // POST /api/v1/quotes/:id/share — mint public token (returned RAW once; stored hashed)
  r.post("/:id/share", async (ctx) => {
    const auth = ctx.state.authContext!;
    const expectedVersion = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const { quote, token } = await service.mintPublicToken(auth, ctx.params.id!, expectedVersion);
    // Return the raw token (for the share URL) + the quote — the token is NOT on
    // the quote doc (hash-only at rest), so it rides in the envelope once.
    respondOk(ctx, { publicToken: token, quote: serializeQuote(auth, quote) });
  });

  // DELETE /api/v1/quotes/:id/share — revoke public token
  r.delete("/:id/share", async (ctx) => {
    const auth = ctx.state.authContext!;
    const expectedVersion = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const revoked = await service.revokePublicToken(auth, ctx.params.id!, expectedVersion);
    respondOk(ctx, serializeQuote(auth, revoked));
  });

  return r;
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
