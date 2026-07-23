import Router from "@koa/router";
import type { Db } from "mongodb";
import { AppError, errors, type Logger } from "@billy/shared";
import type { AuthContext } from "@billy/types";
import type { AppState } from "@/app.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import type { QueueRegistry } from "@/platform/queue.js";
import { validate } from "@/platform/validate.js";
import { respondCreated, respondList, respondOk, stripFinancial, stripFinancialList } from "@/platform/serializer.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import { ContractRepository, CONTRACTS_COLLECTION } from "@/modules/contracts/repository.js";
import { ContractService } from "@/modules/contracts/service.js";
import { ContractCreateSchema, ContractRenewSchema, ContractUpdateSchema } from "@/modules/contracts/schema.js";
import type { Contract } from "@/modules/contracts/types.js";
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

/**
 * Financial fields stripped server-side for callers without
 * `canViewFinancialTotals`: `valueMinor` never travels over the wire —
 * including on list endpoints — for those callers.
 */
const CONTRACT_FINANCIAL_FIELDS = ["valueMinor"] as const;

const asRecord = (doc: Contract): Record<string, unknown> => doc as unknown as Record<string, unknown>;

export const createContractsRouter = (deps: {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
  /** Job-queue producer — required for /send (email + pdf enqueue). Optional so tests may omit it. */
  queue?: QueueRegistry;
}): Router<AppState> => {
  const repo = new ContractRepository(deps.db.collection<Contract>(CONTRACTS_COLLECTION));
  const service = new ContractService({ repo, emitter: deps.emitter, logger: deps.logger });

  // /send + /send/preview wiring (same shape as invoices): constructed only when a
  // job queue is available; the send routes 503 QUEUE_UNAVAILABLE when unconfigured.
  const sendDeps: SendDocumentDeps | null = deps.queue
    ? {
        db: deps.db,
        emailService: new EmailService({ queue: deps.queue, logger: deps.logger }),
        pdfService: new PdfService(deps.queue),
        ownerType: "contract",
        docKind: "contract",
      }
    : null;

  const clients = deps.db.collection("clients");
  /** Look up a client's email (contracts carry only clientId, no snapshot). */
  const clientEmail = async (clientId: string): Promise<string | null> => {
    const c = (await clients.findOne(
      { id: clientId, deletedAt: null },
      { projection: { _id: 0, email: 1 } },
    )) as { email?: string | null } | null;
    return c?.email ?? null;
  };

  /** Map a non-deleted contract to its send compose context (permissive gate). */
  const loadContractCompose = async (
    ctx: AuthContext,
    id: string,
  ): Promise<SendComposeContext | null> => {
    const doc = await service.get(ctx, id); // throws notFound when absent/deleted
    return contractToCompose(doc, await clientEmail(doc.clientId));
  };

  const r = new Router<AppState>({ prefix: "/api/v1/contracts" });

  r.use(requireAuth);

  // GET /api/v1/contracts — list (server paginate/sort/search).
  r.get("/", async (ctx) => {
    const authCtx = ctx.state.authContext!;
    const { items, meta } = await service.list(authCtx, ctx.query);
    respondList(ctx, stripFinancialList(authCtx, items.map(asRecord), CONTRACT_FINANCIAL_FIELDS), meta);
  });

  // GET /api/v1/contracts/:id
  r.get("/:id", async (ctx) => {
    const authCtx = ctx.state.authContext!;
    const doc = await service.get(authCtx, ctx.params.id!);
    respondOk(ctx, stripFinancial(authCtx, asRecord(doc), CONTRACT_FINANCIAL_FIELDS));
  });

  // POST /api/v1/contracts — create
  r.post("/", async (ctx) => {
    const authCtx = ctx.state.authContext!;
    const input = validate(ContractCreateSchema, ctx.request.body);
    const created = await service.create(authCtx, input);
    respondCreated(ctx, stripFinancial(authCtx, asRecord(created), CONTRACT_FINANCIAL_FIELDS));
  });

  // PATCH /api/v1/contracts/:id — versioned update (If-Match / body version)
  r.patch("/:id", async (ctx) => {
    const authCtx = ctx.state.authContext!;
    const input = validate(ContractUpdateSchema, ctx.request.body);
    const expectedVersion = resolveVersion(ctx.get("if-match"), input.version);
    const updated = await service.update(authCtx, ctx.params.id!, expectedVersion, input);
    respondOk(ctx, stripFinancial(authCtx, asRecord(updated), CONTRACT_FINANCIAL_FIELDS));
  });

  // DELETE /api/v1/contracts/:id — soft-delete (capability-gated in the service)
  r.delete("/:id", async (ctx) => {
    await service.softDelete(ctx.state.authContext!, ctx.params.id!);
    respondOk(ctx, { ok: true });
  });

  // POST /api/v1/contracts/:id/archive — versioned archive
  r.post("/:id/archive", async (ctx) => {
    const authCtx = ctx.state.authContext!;
    const expectedVersion = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const archived = await service.archive(authCtx, ctx.params.id!, expectedVersion);
    respondOk(ctx, stripFinancial(authCtx, asRecord(archived), CONTRACT_FINANCIAL_FIELDS));
  });

  // POST /api/v1/contracts/:id/restore — versioned restore
  r.post("/:id/restore", async (ctx) => {
    const authCtx = ctx.state.authContext!;
    const expectedVersion = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const restored = await service.restore(authCtx, ctx.params.id!, expectedVersion);
    respondOk(ctx, stripFinancial(authCtx, asRecord(restored), CONTRACT_FINANCIAL_FIELDS));
  });

  // POST /api/v1/contracts/:id/renew — guarded status transition + new term dates
  r.post("/:id/renew", async (ctx) => {
    const authCtx = ctx.state.authContext!;
    const input = validate(ContractRenewSchema, ctx.request.body);
    const expectedVersion = resolveVersion(ctx.get("if-match"), input.version);
    const renewed = await service.renew(authCtx, ctx.params.id!, expectedVersion, input);
    respondOk(ctx, stripFinancial(authCtx, asRecord(renewed), CONTRACT_FINANCIAL_FIELDS));
  });

  // GET /api/v1/contracts/:id/send/preview?kind= — server-rendered DEFAULT email
  // ({ to, subject, html }). Same shape as invoices; reuses email-service compose.
  r.get("/:id/send/preview", async (ctx) => {
    if (!sendDeps) throw queueUnavailable();
    const auth = ctx.state.authContext!;
    const kind = parseKind(ctx.query.kind);
    const preview = await previewDocumentSend(sendDeps, auth, ctx.params.id!, kind, loadContractCompose);
    respondOk(ctx, preview);
  });

  // POST /api/v1/contracts/:id/send — permissive gate (any non-deleted contract).
  // Attaches the CONTRACT pdf (ownerType "contract"); enqueues a render if none yet.
  // If-Match / body version guarded (mirrors the other contract mutations).
  r.post("/:id/send", async (ctx) => {
    if (!sendDeps) throw queueUnavailable();
    const auth = ctx.state.authContext!;
    const doc = await service.get(auth, ctx.params.id!); // throws notFound when absent/deleted
    resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body)); // enforce version guard
    const body = parseSendBody(ctx.request.body);
    const compose = contractToCompose(doc, await clientEmail(doc.clientId));
    const result = await sendDocument(sendDeps, auth, doc.id, body, compose);
    respondOk(ctx, result);
  });

  return r;
};

const queueUnavailable = (): AppError => {
  return new AppError("QUEUE_UNAVAILABLE", "Email sending is not configured (no job queue)");
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

const contractToCompose = (doc: Contract, email: string | null): SendComposeContext => {
  const title = doc.title || `contract-${doc.id}`;
  return {
    defaultTo: email,
    templateData: {
      // Contracts have no invoice number/amount; the generic/invoice template
      // renders best-effort with the title as the "number" and no amount.
      invoiceNumber: title,
      number: title,
      amountDue: "",
      viewUrl: "",
    },
    attachmentFilename: `${title}.pdf`,
    // No recipient locale: a Contract carries only `clientId` (no clientSnapshot /
    // preferredLanguage), so there is no per-doc language to resolve. Left unset →
    // compose defaults to "en". Also, contracts route through the genericNotification
    // template whose subject/body are not yet catalog-localized (see composeDefault).
  };
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
