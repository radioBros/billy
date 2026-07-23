import Router from "@koa/router";
import type { Db } from "mongodb";
import { AppError, errors, resolveDocumentLocale, type Logger } from "@billy/shared";
import type { AuthContext } from "@billy/types";
import type { AppState } from "@/app.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import type { QueueRegistry } from "@/platform/queue.js";
import { validate } from "@/platform/validate.js";
import { canSeeFinancials, respondCreated, respondList, respondOk } from "@/platform/serializer.js";
import { formatDocumentNumber, nextSequence, type Counter } from "@/platform/numbering.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import { InvoiceRepository, INVOICES_COLLECTION } from "@/modules/invoices/repository.js";
import { ShareTokenStore } from "@/modules/public-links/share-tokens.js";
import { InvoiceService, type BankAccountRecord, type ClientRecord } from "@/modules/invoices/service.js";
import { EmailService } from "@/modules/email/service.js";
import { PdfService } from "@/modules/pdf-generation/service.js";
import {
  previewDocumentSend,
  sendDocument,
  type SendComposeContext,
  type SendDocumentDeps,
  type SendKind,
  type SendRequestBody,
} from "@/modules/email/send-document.js";
import {
  AddPaymentSchema,
  CreateFromQuoteSchema,
  InvoiceCreateSchema,
  InvoiceUpdateSchema,
  ScheduleSchema,
} from "@/modules/invoices/schema.js";
import type { Invoice } from "@/modules/invoices/types.js";

export const createInvoicesRouter = (deps: {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
  /** Job-queue producer — required for /send (email + pdf enqueue). Optional so tests may omit it. */
  queue?: QueueRegistry;
}): Router<AppState> => {
  const repo = new InvoiceRepository(deps.db.collection<Invoice>(INVOICES_COLLECTION));
  const counters = deps.db.collection<Counter>("counters");
  const clients = deps.db.collection("clients");
  const settings = deps.db.collection("settings");

  const service = new InvoiceService({
    repo,
    emitter: deps.emitter,
    logger: deps.logger,
    // finalize reads the clients collection to build the snapshot.
    loadClient: async (ctx, clientId): Promise<ClientRecord | null> => {
      const c = (await clients.findOne(
        { id: clientId, accountId: ctx.accountId, deletedAt: null },
        { projection: { _id: 0 } },
      )) as (ClientRecord & { accountId?: string }) | null;
      // Fall back to an unscoped-by-accountId match if clients aren't scoped
      // that way (clients module currently has no scopeField).
      if (c) return c;
      return (await clients.findOne(
        { id: clientId, deletedAt: null },
        { projection: { _id: 0 } },
      )) as ClientRecord | null;
    },
    // Atomic per-year allocation (numbering.ts): series key + format share the
    // same year so they can never drift. Format is `{seq}/{year}` (e.g. 20/2026);
    // the "Invoice no. … of …" wording is added by the display/PDF layer (i18n).
    nextInvoiceNumber: async (accountId, year): Promise<string> => {
      const seq = await nextSequence(counters, accountId, `invoice-${year}`);
      return formatDocumentNumber({ prefix: "INV", seq, padding: 4, year, style: "slashYear" });
    },
    // Read settings.invoicing.overpaymentToleranceMinor once the settings module
    // exposes it; default 0 for now.
    overpaymentToleranceMinor: 0,
    // Hashed share-token store for /share.
    shareTokens: new ShareTokenStore(deps.db),
    // Multi-bank: read the business-settings singleton's bankAccounts. The settings
    // doc is single-tenant (`{ key: "business", data }`) — no accountId filter.
    // Missing/legacy docs have no bankAccounts → [].
    loadBankAccounts: async (): Promise<BankAccountRecord[]> => {
      const doc = (await settings.findOne(
        { key: "business" },
        { projection: { _id: 0, "data.bankAccounts": 1 } },
      )) as { data?: { bankAccounts?: BankAccountRecord[] } } | null;
      return doc?.data?.bankAccounts ?? [];
    },
  });

  // /send + /send/preview wiring: constructed only when a job queue is available
  // (the router itself always mounts — unlike pdf-generation — so the guard lives
  // on the send routes, which 503 QUEUE_UNAVAILABLE when unconfigured).
  const sendDeps: SendDocumentDeps | null = deps.queue
    ? {
        db: deps.db,
        emailService: new EmailService({ queue: deps.queue, logger: deps.logger }),
        pdfService: new PdfService(deps.queue),
        ownerType: "invoice",
        docKind: "invoice",
      }
    : null;

  /** Map a finalized-or-later invoice to its send compose context (or null). */
  const loadInvoiceCompose = async (
    ctx: AuthContext,
    id: string,
  ): Promise<SendComposeContext | null> => {
    const inv = await service.get(ctx, id); // throws notFound when absent
    return invoiceToCompose(inv);
  };

  const r = new Router<AppState>({ prefix: "/api/v1/invoices" });
  r.use(requireAuth);

  // GET /api/v1/invoices — list
  r.get("/", async (ctx) => {
    const auth = ctx.state.authContext!;
    const { items, meta } = await service.list(auth, ctx.query);
    respondList(ctx, items.map((i) => stripInvoiceFinancial(auth, i)), meta);
  });

  // GET /api/v1/invoices/:id
  r.get("/:id", async (ctx) => {
    const auth = ctx.state.authContext!;
    const inv = await service.get(auth, ctx.params.id!);
    respondOk(ctx, stripInvoiceFinancial(auth, inv));
  });

  // POST /api/v1/invoices — create draft
  r.post("/", async (ctx) => {
    const auth = ctx.state.authContext!;
    const input = validate(InvoiceCreateSchema, ctx.request.body);
    const created = await service.create(auth, input);
    respondCreated(ctx, stripInvoiceFinancial(auth, created));
  });

  // POST /api/v1/invoices/from-quote — draft from an accepted quote
  r.post("/from-quote", async (ctx) => {
    const auth = ctx.state.authContext!;
    const input = validate(CreateFromQuoteSchema, ctx.request.body);
    const created = await service.createFromQuote(auth, input);
    respondCreated(ctx, stripInvoiceFinancial(auth, created));
  });

  // PATCH /api/v1/invoices/:id — versioned draft update
  r.patch("/:id", async (ctx) => {
    const auth = ctx.state.authContext!;
    const input = validate(InvoiceUpdateSchema, ctx.request.body);
    const version = resolveVersion(ctx.get("if-match"), input.version);
    const updated = await service.update(auth, ctx.params.id!, version, input);
    respondOk(ctx, stripInvoiceFinancial(auth, updated));
  });

  // DELETE /api/v1/invoices/:id — soft-delete (draft-only in practice; finalized retained)
  r.delete("/:id", async (ctx) => {
    const auth = ctx.state.authContext!;
    await service.softDelete(auth, ctx.params.id!);
    respondOk(ctx, { ok: true });
  });

  // POST /api/v1/invoices/:id/archive
  r.post("/:id/archive", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const archived = await service.archive(auth, ctx.params.id!, version);
    respondOk(ctx, stripInvoiceFinancial(auth, archived));
  });

  // POST /api/v1/invoices/:id/restore
  r.post("/:id/restore", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const restored = await service.restore(auth, ctx.params.id!, version);
    respondOk(ctx, stripInvoiceFinancial(auth, restored));
  });

  // POST /api/v1/invoices/:id/finalize — assign number + snapshot + lock
  r.post("/:id/finalize", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const finalized = await service.finalize(auth, ctx.params.id!, version);
    respondOk(ctx, stripInvoiceFinancial(auth, finalized));
  });

  // POST /api/v1/invoices/:id/void
  r.post("/:id/void", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const voided = await service.void(auth, ctx.params.id!, version);
    respondOk(ctx, stripInvoiceFinancial(auth, voided));
  });

  // POST /api/v1/invoices/:id/schedule — draft → scheduled (worker finalizes on the date)
  r.post("/:id/schedule", async (ctx) => {
    const auth = ctx.state.authContext!;
    const body = ctx.request.body as { scheduledSendDate?: unknown; version?: unknown };
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(body));
    const parsed = validate(ScheduleSchema, { scheduledSendDate: body.scheduledSendDate });
    const scheduled = await service.schedule(auth, ctx.params.id!, version, parsed.scheduledSendDate);
    respondOk(ctx, stripInvoiceFinancial(auth, scheduled));
  });

  // POST /api/v1/invoices/:id/unschedule — scheduled → draft
  r.post("/:id/unschedule", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const draft = await service.unschedule(auth, ctx.params.id!, version);
    respondOk(ctx, stripInvoiceFinancial(auth, draft));
  });

  // POST /api/v1/invoices/:id/payments — add payment (transactional recompute)
  r.post("/:id/payments", async (ctx) => {
    const auth = ctx.state.authContext!;
    const input = validate(AddPaymentSchema, ctx.request.body);
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const updated = await service.addPayment(auth, ctx.params.id!, version, input);
    respondOk(ctx, stripInvoiceFinancial(auth, updated));
  });

  // POST /api/v1/invoices/:id/share — mint public token (idempotent), behind requireAuth
  // (mirrors quotes' /share: no extra capability gate). Returns the raw token in the
  // standard envelope, NOT the serialized invoice — no financial stripping applies.
  r.post("/:id/share", async (ctx) => {
    const auth = ctx.state.authContext!;
    const { token } = await service.mintPublicToken(auth, ctx.params.id!);
    // Raw token returned ONCE (for the share URL); stored hashed at rest.
    respondOk(ctx, { publicToken: token });
  });

  // DELETE /api/v1/invoices/:id/payments/:paymentId — remove payment (audited)
  r.delete("/:id/payments/:paymentId", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const updated = await service.removePayment(auth, ctx.params.id!, version, ctx.params.paymentId!);
    respondOk(ctx, stripInvoiceFinancial(auth, updated));
  });

  // GET /api/v1/invoices/:id/send/preview?kind= — server-rendered DEFAULT email the
  // send modal pre-fills ({ to, subject, html }). Reuses the email-service compose.
  r.get("/:id/send/preview", async (ctx) => {
    if (!sendDeps) throw queueUnavailable();
    const auth = ctx.state.authContext!;
    const kind = parseKind(ctx.query.kind);
    const preview = await previewDocumentSend(sendDeps, auth, ctx.params.id!, kind, loadInvoiceCompose);
    respondOk(ctx, preview);
  });

  // POST /api/v1/invoices/:id/send — finalized-or-later gate; attach the clean PDF
  // (enqueue a render if none yet); enqueue the email job (subject/body verbatim
  // when supplied, else composed default). If-Match / body version guarded.
  r.post("/:id/send", async (ctx) => {
    if (!sendDeps) throw queueUnavailable();
    const auth = ctx.state.authContext!;
    const inv = await service.get(auth, ctx.params.id!); // throws notFound when absent
    resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body)); // enforce version guard
    if (!isFinalizedOrLater(inv.status)) {
      throw new AppError(
        "INVALID_STATE_TRANSITION",
        "Invoice must be finalized before it can be sent",
      );
    }
    const body = parseSendBody(ctx.request.body);
    const result = await sendDocument(sendDeps, auth, inv.id, body, invoiceToCompose(inv));
    respondOk(ctx, result);
  });

  return r;
};

const queueUnavailable = (): AppError => {
  return new AppError("QUEUE_UNAVAILABLE", "Email sending is not configured (no job queue)");
};

/** Statuses at or beyond `finalized` (a draft/scheduled invoice cannot be sent). */
const FINALIZED_OR_LATER: ReadonlySet<string> = new Set([
  "finalized",
  "sent",
  "partially_paid",
  "paid",
  "void",
]);
const isFinalizedOrLater = (status: string): boolean => {
  return FINALIZED_OR_LATER.has(status);
};

const parseKind = (raw: unknown): SendKind => {
  return raw === "reminder" ? "reminder" : "invoice";
};

const parseSendBody = (raw: unknown): SendRequestBody => {
  const b = (raw ?? {}) as Record<string, unknown>;
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  return {
    ...(typeof b.to === "string" ? { to: b.to } : {}),
    ...(strArr(b.cc) ? { cc: strArr(b.cc) } : {}),
    ...(strArr(b.bcc) ? { bcc: strArr(b.bcc) } : {}),
    ...(typeof b.subject === "string" ? { subject: b.subject } : {}),
    ...(typeof b.body === "string" ? { body: b.body } : {}),
    kind: parseKind(b.kind),
  };
};

const displayAmount = (minor: number | undefined, currency: string): string => {
  if (minor === undefined) return "";
  return `${currency} ${(minor / 100).toFixed(2)}`;
};

const invoiceToCompose = (inv: Invoice): SendComposeContext => {
  const number = inv.invoiceNumber ?? "";
  return {
    defaultTo: inv.clientSnapshot?.email ?? null,
    templateData: {
      invoiceNumber: number,
      amountDue: displayAmount(inv.amountDueMinor ?? inv.grandTotalMinor, inv.currency),
      viewUrl: "",
    },
    attachmentFilename: `${number || `invoice-${inv.id}`}.pdf`,
    // Recipient locale from the client tier (company default deferred → undefined).
    locale: resolveDocumentLocale(inv.clientSnapshot?.preferredLanguage),
  };
};

/** Top-level money fields removed for non-financial callers. */
const INVOICE_MONEY_FIELDS = [
  "subtotalMinor",
  "discountMinor",
  "taxMinor",
  "grandTotalMinor",
  "amountPaidMinor",
  "amountDueMinor",
] as const;
const LINE_MONEY_FIELDS = ["unitPriceMinor", "lineSubtotalMinor", "lineDiscountMinor", "lineTaxMinor", "lineTotalMinor"];

export const stripInvoiceFinancial = (ctx: AuthContext, inv: Invoice): Invoice => {
  if (canSeeFinancials(ctx)) return inv;
  const copy = { ...inv } as Record<string, unknown>;
  for (const f of INVOICE_MONEY_FIELDS) delete copy[f];
  if (Array.isArray(inv.lineItems)) {
    copy.lineItems = inv.lineItems.map((li) => {
      const l = { ...(li as unknown as Record<string, unknown>) };
      for (const f of LINE_MONEY_FIELDS) delete l[f];
      return l;
    });
  }
  if (Array.isArray(inv.payments)) {
    copy.payments = inv.payments.map((p) => {
      const { amountMinor: _drop, ...rest } = p as unknown as Record<string, unknown> & { amountMinor?: unknown };
      void _drop;
      return rest;
    });
  }
  return copy as unknown as Invoice;
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
