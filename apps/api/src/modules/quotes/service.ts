import type { Db } from "mongodb";
import type { AuthContext, ListMeta } from "@billy/types";
import { AppError, errors } from "@billy/shared";
import { BaseService, assertTransition, type ServiceDeps } from "@/platform/service.js";
import { computeDocumentTotals, type LineItemComputed, type LineItemInput } from "@/platform/money.js";
import { formatDocumentNumber, nextSequence, type Counter } from "@/platform/numbering.js";
import type { SupportedEmailLocale } from "@/modules/email/service.js";
import { formatMoney } from "@/modules/pdf-generation/template.js";
import type { ShareTokenStore } from "@/modules/public-links/share-tokens.js";
import type { QuoteRepository } from "@/modules/quotes/repository.js";
import { QUOTE_LIST_WHITELIST, type QuoteCreateInput, type QuoteUpdateInput } from "@/modules/quotes/schema.js";
import type {
  ClientSnapshot,
  ConvertToInvoiceLineInput,
  ConvertToInvoicePayload,
  ConvertedInvoiceRef,
  Quote,
  QuoteStatus,
} from "@/modules/quotes/types.js";

/**
 * Quote business logic. All logic lives here, never in
 * the controllers. Owns: create/update/get/list/archive/restore/soft-delete,
 * the lifecycle actions (send/accept/decline/convert), public-token mint/revoke,
 * SERVER-side money recompute on every write, atomic numbering, client snapshot at
 * send, and `quote.*` domain events. Every repository call threads the mandatory
 * `authContext`.
 *
 * MONEY: totals are ALWAYS recomputed from the raw line inputs via
 * `computeDocumentTotals` — client-sent totals are never trusted.
 */

/**
 * Allowed status transitions:
 *   draft → sent → accepted | declined | expired;  accepted → converted.
 */
const QUOTE_TRANSITIONS: Partial<Record<QuoteStatus, readonly QuoteStatus[]>> = {
  draft: ["sent"],
  sent: ["accepted", "declined", "expired"],
  accepted: ["converted"],
};

/** Minimal shape read from the `clients` collection for the send-time snapshot. */
interface ClientRecord {
  id: string;
  displayName: string;
  legalName?: string | null;
  email?: string | null;
  billingAddress?: unknown;
  vatNumber?: string | null;
  taxCode?: string | null;
  preferredCurrency?: string | null;
  preferredLanguage?: string | null;
  referral?: string | null;
}

/**
 * Minimal email port (structural — the EmailService satisfies it). Optional +
 * best-effort: a send that throws (or a down queue) must NEVER fail the quote
 * transition. Kept as a narrow interface so the quotes module doesn't hard-depend
 * on the email module's concrete class.
 */
export interface QuoteEmailPort {
  send(input: {
    to: string;
    template: "quote-sent";
    data?: Record<string, unknown>;
    accountId: string;
    locale?: SupportedEmailLocale;
    idempotencyParts?: readonly string[];
  }): Promise<string>;
}

/**
 * Invoice ports used by `convert` (quotes → invoices seam). The router wires them
 * to the invoices module (`InvoiceService.createFromQuote` + a scoped lookup), so
 * this module never imports the invoices service directly and tests can fake them.
 */
export interface QuoteInvoicePorts {
  /** Create a DRAFT invoice from the conversion payload. */
  createInvoiceFromQuote(ctx: AuthContext, payload: ConvertToInvoicePayload): Promise<ConvertedInvoiceRef>;
  /**
   * An existing (non-deleted, non-void) invoice already created from this quote in
   * the caller's account — lets a retry after a failed link reuse it instead of
   * creating a duplicate.
   */
  findInvoiceForQuote(ctx: AuthContext, quoteId: string): Promise<ConvertedInvoiceRef | null>;
  /** Discard a draft invoice this request created but lost the race to link. Optional. */
  discardInvoice?(ctx: AuthContext, invoiceId: string): Promise<void>;
}

export interface QuoteServiceDeps extends ServiceDeps<Quote> {
  repo: QuoteRepository;
  db: Db;
  /** Optional transactional emailer; when present, `/send` emails the client. */
  emailer?: QuoteEmailPort;
  /** Hashed share-token store (public-links); required for `/share`. */
  shareTokens?: ShareTokenStore;
  /** Invoice ports for `convert`. Required for convert (it throws internal when unwired). */
  invoices?: QuoteInvoicePorts;
}

const nowIso = (): string => new Date().toISOString();

/**
 * Strip a computed line back to its RAW inputs (the invoice recomputes the money).
 * Every input field is kept — including the FatturaPA `nature` code, which a 0%
 * line needs on the e-invoice.
 */
export const toRawLine = (l: LineItemInput): ConvertToInvoiceLineInput => {
  const raw: ConvertToInvoiceLineInput = {
    description: l.description,
    quantity: l.quantity,
    unitPriceMinor: l.unitPriceMinor,
  };
  if (l.discountRate != null) raw.discountRate = l.discountRate;
  if (l.taxRate != null) raw.taxRate = l.taxRate;
  if (l.nature != null) raw.nature = l.nature;
  return raw;
};

/** Minimal read shape of the account's business settings (`key: "business"`). */
interface BusinessSettingsDoc {
  data?: { businessName?: string | null } | null;
}

export class QuoteService extends BaseService<Quote> {
  protected override readonly repo: QuoteRepository;
  private readonly db: Db;
  private readonly emailer?: QuoteEmailPort;
  private readonly shareTokens?: ShareTokenStore;
  private readonly invoices?: QuoteInvoicePorts;

  constructor(deps: QuoteServiceDeps) {
    super(deps);
    this.repo = deps.repo;
    this.db = deps.db;
    this.emailer = deps.emailer;
    this.shareTokens = deps.shareTokens;
    this.invoices = deps.invoices;
  }

  /** The ACCOUNT's own business name (business settings), for the client-facing email. */
  private async businessName(accountId: string): Promise<string> {
    const doc = (await this.db
      .collection("settings")
      .findOne({ key: "business", accountId }, { projection: { _id: 0, "data.businessName": 1 } })) as BusinessSettingsDoc | null;
    return doc?.data?.businessName ?? "";
  }

  /** The 7 supported locales; anything else (or null) → "en". */
  private static readonly SUPPORTED: readonly SupportedEmailLocale[] = ["en", "es", "it", "fr", "ru", "pt", "de"];
  private localeOf(pref?: string | null): SupportedEmailLocale {
    const base = (pref ?? "").slice(0, 2).toLowerCase();
    return (QuoteService.SUPPORTED as readonly string[]).includes(base) ? (base as SupportedEmailLocale) : "en";
  }

  /** Recompute the four doc totals + computed lines from raw line inputs. */
  private computeTotals(lineItems: readonly LineItemInput[]): {
    lineItems: LineItemComputed[];
    subtotalMinor: number;
    discountMinor: number;
    taxMinor: number;
    grandTotalMinor: number;
  } {
    const t = computeDocumentTotals(lineItems);
    return {
      lineItems: t.lines,
      subtotalMinor: t.subtotalMinor,
      discountMinor: t.discountMinor,
      taxMinor: t.taxMinor,
      grandTotalMinor: t.grandTotalMinor,
    };
  }

  async create(ctx: AuthContext, input: QuoteCreateInput): Promise<Quote> {
    // Totals are recomputed server-side — any client-sent totals were already
    // stripped by the schema, and are never read here.
    const totals = this.computeTotals(input.lineItems);
    const created = await this.repo.insert(ctx, {
      clientId: input.clientId,
      projectId: input.projectId ?? null,
      clientSnapshot: null,
      quoteNumber: null,
      currency: input.currency,
      issueDate: input.issueDate,
      expiryDate: input.expiryDate,
      subject: input.subject ?? null,
      notes: input.notes ?? null,
      status: "draft",
      convertedInvoiceId: null,
      ...totals,
    } as Omit<Quote, "id" | "version" | "createdAt" | "updatedAt" | "archivedAt" | "deletedAt">);
    await this.emit({
      name: "quote.created",
      actorId: ctx.userId,
      entityType: "quote",
      entityId: created.id,
    });
    return created;
  }

  async get(ctx: AuthContext, id: string): Promise<Quote> {
    const doc = await this.repo.findById(ctx, id);
    if (!doc) throw errors.notFound();
    return doc;
  }

  async list(
    ctx: AuthContext,
    rawQuery: Record<string, string | string[] | undefined>,
  ): Promise<{ items: Quote[]; meta: ListMeta }> {
    const { items, parsed, total } = await this.repo.list(ctx, rawQuery, QUOTE_LIST_WHITELIST);
    const meta: ListMeta = {
      page: parsed.page,
      limit: parsed.limit,
      total,
      pageCount: Math.max(1, Math.ceil(total / parsed.limit)),
      sort: parsed.sortSpec,
      ...(parsed.q ? { q: parsed.q } : {}),
    };
    return { items, meta };
  }

  /** Versioned update. Re-recomputes totals whenever lineItems change. */
  async update(ctx: AuthContext, id: string, expectedVersion: number, input: QuoteUpdateInput): Promise<Quote> {
    // `version` is the concurrency guard, never persisted data.
    const { version: _ignored, lineItems, ...rest } = input;
    void _ignored;
    const patch: Partial<Quote> = { ...(rest as Partial<Quote>) };
    if (lineItems !== undefined) {
      Object.assign(patch, this.computeTotals(lineItems));
    }
    const updated = await this.repo.updateVersioned(ctx, id, expectedVersion, patch);
    await this.emit({ name: "quote.updated", actorId: ctx.userId, entityType: "quote", entityId: updated.id });
    return updated;
  }

  async archive(ctx: AuthContext, id: string, expectedVersion: number): Promise<Quote> {
    const archived = await this.repo.archive(ctx, id, expectedVersion);
    await this.emit({ name: "quote.updated", actorId: ctx.userId, entityType: "quote", entityId: archived.id, payload: { archived: true } });
    return archived;
  }

  async restore(ctx: AuthContext, id: string, expectedVersion: number): Promise<Quote> {
    const restored = await this.repo.restore(ctx, id, expectedVersion);
    await this.emit({ name: "quote.updated", actorId: ctx.userId, entityType: "quote", entityId: restored.id, payload: { restored: true } });
    return restored;
  }

  /** Soft-delete (DELETE /:id → `deletedAt`). Gated by `canPermanentlyDelete`. */
  async softDelete(ctx: AuthContext, id: string): Promise<void> {
    this.requireCapability(ctx, "canPermanentlyDelete");
    const existing = await this.repo.findById(ctx, id);
    if (!existing) throw errors.notFound();
    await this.repo.softDelete(ctx, id);
    await this.emit({ name: "quote.updated", actorId: ctx.userId, entityType: "quote", entityId: id, payload: { deleted: true } });
  }

  /**
   * Send (draft → sent): freeze the client snapshot from the
   * live `clients` record and assign an atomic `Q-{YEAR}-{SEQ}` number. Numbering
   * is gap-safe: assigned only at send. Emits `quote.sent`.
   */
  async send(ctx: AuthContext, id: string, expectedVersion: number): Promise<Quote> {
    const quote = await this.get(ctx, id);
    assertTransition<QuoteStatus>(quote.status, "sent", QUOTE_TRANSITIONS);

    const client = await this.db
      .collection<ClientRecord>("clients")
      .findOne({ id: quote.clientId, accountId: ctx.accountId, deletedAt: null }, { projection: { _id: 0 } });
    if (!client) throw errors.notFound("Client not found for snapshot");

    const clientSnapshot: ClientSnapshot = {
      clientId: client.id,
      displayName: client.displayName,
      legalName: client.legalName ?? null,
      email: client.email ?? null,
      billingAddress: client.billingAddress ?? null,
      vatNumber: client.vatNumber ?? null,
      taxCode: client.taxCode ?? null,
      currency: quote.currency,
      preferredLanguage: client.preferredLanguage ?? null,
      referral: client.referral ?? null,
      snapshotAt: nowIso(),
    };

    // The series year is the quote's OWN issue year (like every other document
    // type), not the wall-clock year — a quote dated 2025 sent in 2026 is Q-…/2025.
    const year = Number(quote.issueDate.slice(0, 4));
    const seq = await nextSequence(this.db.collection<Counter>("counters"), ctx.accountId, `quote-${year}`);
    const quoteNumber = formatDocumentNumber({ prefix: "Q", seq, padding: 4, year, style: "slashYear" });

    const updated = await this.repo.updateVersioned(ctx, id, expectedVersion, {
      status: "sent",
      clientSnapshot,
      quoteNumber,
    } as Partial<Quote>);
    await this.emit({
      name: "quote.sent",
      actorId: ctx.userId,
      entityType: "quote",
      entityId: updated.id,
      payload: { quoteNumber },
    });

    // Best-effort transactional email to the client, in THEIR locale. Never let a
    // send/enqueue failure fail the transition (the quote IS sent regardless);
    // idempotent by (quoteId, "sent") so a retry can't double-email. Skipped when
    // no emailer is wired (tests) or the client has no email address.
    if (this.emailer && client.email) {
      try {
        await this.emailer.send({
          to: client.email,
          template: "quote-sent",
          accountId: ctx.accountId,
          locale: this.localeOf(client.preferredLanguage),
          data: {
            quoteNumber,
            // Formatted money in the quote's currency (e.g. "EUR 1,234.56"), never raw minor units.
            total: updated.grandTotalMinor != null ? formatMoney(updated.grandTotalMinor, updated.currency) : "",
            // The SENDER is this account's business, not the client.
            businessName: await this.businessName(ctx.accountId),
            // Same as the invoice email: no public link is minted on send (minting would
            // rotate — and kill — any share link the user already handed out).
            viewUrl: "",
          },
          idempotencyParts: [updated.id, "sent"],
        });
      } catch (err) {
        this.logger.warn({ err, quoteId: updated.id }, "quote.sent email enqueue failed (non-fatal)");
      }
    }
    return updated;
  }

  /** Accept (sent → accepted). Emits `quote.accepted`. */
  async accept(ctx: AuthContext, id: string, expectedVersion: number): Promise<Quote> {
    return this.transitionSimple(ctx, id, expectedVersion, "accepted", "quote.accepted");
  }

  /** Decline (sent → declined). Emits `quote.declined`. */
  async decline(ctx: AuthContext, id: string, expectedVersion: number): Promise<Quote> {
    return this.transitionSimple(ctx, id, expectedVersion, "declined", "quote.declined");
  }

  private async transitionSimple(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    next: QuoteStatus,
    eventName: string,
  ): Promise<Quote> {
    const quote = await this.get(ctx, id);
    assertTransition<QuoteStatus>(quote.status, next, QUOTE_TRANSITIONS);
    const updated = await this.repo.updateVersioned(ctx, id, expectedVersion, { status: next } as Partial<Quote>);
    await this.emit({ name: eventName, actorId: ctx.userId, entityType: "quote", entityId: updated.id });
    return updated;
  }

  /**
   * Convert (accepted → converted) — creates the DRAFT invoice server-side in the
   * same request and links it. Order (so a failure can never leave the quote
   * "converted" without an invoice):
   *   1. guards: already converted → QUOTE_ALREADY_CONVERTED; transition; snapshot;
   *      stale `expectedVersion` → VERSION_CONFLICT BEFORE any invoice is created;
   *   2. reuse an invoice already created from this quote (a previous attempt whose
   *      link failed) or create one via `createFromQuote` (raw lines incl. `nature`,
   *      subject, projectId, notes, client snapshot);
   *   3. ONE version-guarded write sets `status: converted` AND `convertedInvoiceId`
   *      together. If it fails, the quote stays `accepted` and the draft invoice
   *      exists: a race loser discards its own draft; otherwise the error names the
   *      invoice and a retry reuses it (step 2).
   * REPAIR: a quote marked `converted` WITHOUT a linked invoice (converted by the
   * old flow, which never created one) is convertible again — it gets its invoice.
   */
  async convert(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
  ): Promise<{ quote: Quote; invoice: ConvertedInvoiceRef }> {
    if (!this.invoices) throw errors.internal("Quote convert not configured");
    const quote = await this.get(ctx, id);
    if (quote.convertedInvoiceId) {
      throw new AppError("QUOTE_ALREADY_CONVERTED", "Quote already converted to an invoice");
    }
    // Legacy "converted" with no invoice → repair (create + link); otherwise accepted → converted.
    if (quote.status !== "converted") assertTransition<QuoteStatus>(quote.status, "converted", QUOTE_TRANSITIONS);

    if (!quote.clientSnapshot) {
      // Snapshot is frozen at send; an accepted quote always has one, but guard defensively.
      throw new AppError("INVALID_STATE_TRANSITION", "Quote has no client snapshot to convert");
    }
    // Fail fast on a stale click: never create an invoice we could not link.
    if (quote.version !== expectedVersion) throw errors.versionConflict();

    const payload = this.toInvoicePayload(quote, quote.clientSnapshot);
    const existing = await this.invoices.findInvoiceForQuote(ctx, quote.id);
    const invoice = existing ?? (await this.invoices.createInvoiceFromQuote(ctx, payload));
    const createdHere = !existing;

    let updated: Quote;
    try {
      updated = await this.repo.updateVersioned(ctx, id, expectedVersion, {
        status: "converted",
        convertedInvoiceId: invoice.id,
      } as Partial<Quote>);
    } catch (err) {
      // Lost a race to a concurrent convert? Then drop OUR draft (it would be a duplicate).
      const current = await this.repo.findById(ctx, id).catch(() => null);
      // A concurrent request already linked THIS very invoice (we reused it) → success.
      if (current?.convertedInvoiceId === invoice.id) return { quote: current, invoice };
      if (current?.convertedInvoiceId && current.convertedInvoiceId !== invoice.id) {
        if (createdHere && this.invoices.discardInvoice) {
          await this.invoices.discardInvoice(ctx, invoice.id).catch((e: unknown) => {
            this.logger.warn({ err: e, quoteId: id, invoiceId: invoice.id }, "quote.convert: discarding duplicate draft failed");
          });
        }
        throw new AppError("QUOTE_ALREADY_CONVERTED", "Quote already converted to an invoice");
      }
      this.logger.error({ err, quoteId: id, invoiceId: invoice.id }, "quote.convert: invoice created but linking it to the quote failed");
      const code = err instanceof AppError ? err.code : "INTERNAL_ERROR";
      throw new AppError(
        code,
        `Draft invoice ${invoice.id} was created but could not be linked to the quote; retry the conversion to link it`,
        { details: { invoiceId: invoice.id } },
      );
    }
    await this.emit({
      name: "quote.converted",
      actorId: ctx.userId,
      entityType: "quote",
      entityId: updated.id,
      payload: { invoiceId: invoice.id },
    });
    return { quote: updated, invoice };
  }

  /** The `createFromQuote` handoff: RAW lines (the invoice recomputes money). */
  private toInvoicePayload(quote: Quote, clientSnapshot: ClientSnapshot): ConvertToInvoicePayload {
    return {
      quoteId: quote.id,
      clientId: quote.clientId,
      clientSnapshot,
      currency: quote.currency,
      lineItems: quote.lineItems.map(toRawLine),
      notes: quote.notes ?? null,
      subject: quote.subject ?? null,
      projectId: quote.projectId ?? null,
    };
  }

  /** Link the invoice created from a converted quote (invoices module supplies the id). */
  async linkConvertedInvoice(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    invoiceId: string,
  ): Promise<Quote> {
    return this.repo.updateVersioned(ctx, id, expectedVersion, {
      convertedInvoiceId: invoiceId,
    } as Partial<Quote>);
  }

  /**
   * Mint a 256-bit public share token. The RAW token is stored HASHED in the
   * `shareTokens` collection (never on the quote doc, never at rest) and returned
   * once for the share URL. Re-sharing ROTATES (supersedes the prior token → old
   * link dies) — a hashed store cannot hand back a previous raw token. Emits
   * `quote.updated`. Requires a wired `shareTokens` store.
   */
  async mintPublicToken(ctx: AuthContext, id: string, expectedVersion: number): Promise<{ quote: Quote; token: string }> {
    if (!this.shareTokens) throw errors.internal("Share-token store not configured");
    // Bump version + emit via a no-op state touch so the concurrency guard + audit
    // still apply, but the token itself lives in shareTokens, not on the doc.
    const quote = await this.repo.updateVersioned(ctx, id, expectedVersion, {} as Partial<Quote>);
    const token = await this.shareTokens.mint("quote", id, ctx.userId);
    await this.emit({ name: "quote.updated", actorId: ctx.userId, entityType: "quote", entityId: quote.id, payload: { shared: true } });
    return { quote, token };
  }

  /** Revoke the public share token (deletes the shareTokens row). Emits `quote.updated`. */
  async revokePublicToken(ctx: AuthContext, id: string, expectedVersion: number): Promise<Quote> {
    const quote = await this.repo.updateVersioned(ctx, id, expectedVersion, {} as Partial<Quote>);
    if (this.shareTokens) await this.shareTokens.revokeForDocument("quote", id);
    await this.emit({ name: "quote.updated", actorId: ctx.userId, entityType: "quote", entityId: quote.id, payload: { shared: false } });
    return quote;
  }
}
