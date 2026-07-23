import type { AuthContext, ListMeta } from "@billy/types";
import { AppError, errors } from "@billy/shared";
import { BaseService, assertTransition, type ServiceDeps } from "@/platform/service.js";
import { computeDocumentTotals, type LineItemInput } from "@/platform/money.js";
import type { ProformaRepository } from "@/modules/proforma/repository.js";
import { PROFORMA_LIST_WHITELIST, type ProformaCreateInput, type ProformaUpdateInput } from "@/modules/proforma/schema.js";
import type { ClientSnapshot, Proforma, ProformaStatus } from "@/modules/proforma/types.js";

/**
 * Proforma business logic. All logic
 * lives here, never in controllers. Owns: draft create/update, issue
 * (number + snapshot + lock), void, and `proforma.*` events.
 * Every repo call threads `authContext`.
 *
 * NON-FISCAL: a proforma has no payments and no balance fields; it affects no
 * revenue/outstanding. Server-authority invariants:
 *  - Totals recomputed from `lineItems` via `computeDocumentTotals` — client totals
 *    ignored. Same shared util as quotes/invoices/recurring.
 *  - `proformaNumber` assigned once, inside `issue`; the editor can never set it.
 *  - Issued proformas are immutable (only void/archive/restore, or convert).
 *
 * DEFERRED (see types.ts): convert → real `Invoice` mints an invoice and would
 * require importing/mutating the invoices module — out of scope. The integrator wires
 * it by reading the proforma (line items + `clientSnapshot`), calling the invoices
 * service's `createFromQuote`-style ingestion with `sourceType=proforma`, then calling
 * `markConverted` here with the new invoice id. PDF, send/email, expiry scanner,
 * notifications are separate follow-ups.
 */

/** Injected client read (issue snapshots the client by reading the clients collection). */
export type LoadClient = (ctx: AuthContext, clientId: string) => Promise<ClientRecord | null>;

/** Minimal client shape issue needs to build a snapshot (mirrors invoices). */
export interface ClientRecord {
  id: string;
  displayName: string;
  legalName?: string | null;
  email?: string | null;
  billingAddress?: unknown | null;
  vatNumber?: string | null;
  preferredCurrency?: string | null;
  preferredLanguage?: string | null;
  referral?: string | null;
}

/** Injected proforma-number allocator (issue). Real impl uses platform numbering. */
export type NextProformaNumber = (accountId: string, year: number) => Promise<string>;

/**
 * The proforma data handed to the invoice-minting port on convert. Carries
 * everything the invoices module needs to build a DRAFT invoice: the source
 * `clientId`, `currency`, `lineItems`, and `notes`. The mint impl calls
 * `InvoiceService.create` — which re-snapshots the client at finalize from
 * `clientId` — so we pass the id, consistent with the normal invoice flow.
 */
export interface ProformaConvertData {
  proformaId: string;
  clientId: string;
  currency: string;
  lineItems: Proforma["lineItems"];
  notes?: string | null;
}

/** Minimal minted-invoice shape convert returns (mirrors the injected-port pattern). */
export interface MintedInvoice {
  id: string;
}

/**
 * Injected invoice-minting port (convert). Crosses proforma→invoices; the impl
 * calls `InvoiceService.create`. OPTIONAL — `convert` throws internal when unwired.
 */
export type MintInvoiceFromProforma<T extends MintedInvoice = MintedInvoice> = (
  ctx: AuthContext,
  data: ProformaConvertData,
) => Promise<T>;

/** Injected invoice loader for idempotent-replay (return the already-minted invoice). OPTIONAL. */
export type LoadInvoice<T extends MintedInvoice = MintedInvoice> = (
  ctx: AuthContext,
  invoiceId: string,
) => Promise<T | null>;

export interface ProformaServiceDeps extends ServiceDeps<Proforma> {
  repo: ProformaRepository;
  loadClient: LoadClient;
  nextProformaNumber: NextProformaNumber;
  /** Mint a DRAFT invoice from a proforma (convert). Optional — omit to disable convert. */
  mintInvoiceFromProforma?: MintInvoiceFromProforma;
  /** Load an existing invoice (idempotent convert replay). Optional; required for convert. */
  loadInvoice?: LoadInvoice;
}

/** Explicit-action transitions only. */
const ALLOWED_TRANSITIONS: Partial<Record<ProformaStatus, readonly ProformaStatus[]>> = {
  draft: ["issued", "void"],
  issued: ["void"],
};

export class ProformaService extends BaseService<Proforma> {
  protected override readonly repo: ProformaRepository;
  private readonly loadClient: LoadClient;
  private readonly nextProformaNumber: NextProformaNumber;
  private readonly mintInvoiceFromProforma?: MintInvoiceFromProforma;
  private readonly loadInvoice?: LoadInvoice;

  constructor(deps: ProformaServiceDeps) {
    super(deps);
    this.repo = deps.repo;
    this.loadClient = deps.loadClient;
    this.nextProformaNumber = deps.nextProformaNumber;
    this.mintInvoiceFromProforma = deps.mintInvoiceFromProforma;
    this.loadInvoice = deps.loadInvoice;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  async get(ctx: AuthContext, id: string): Promise<Proforma> {
    const doc = await this.repo.findById(ctx, id);
    if (!doc) throw errors.notFound();
    return doc;
  }

  async list(
    ctx: AuthContext,
    rawQuery: Record<string, string | string[] | undefined>,
  ): Promise<{ items: Proforma[]; meta: ListMeta }> {
    const { items, parsed, total } = await this.repo.list(ctx, rawQuery, PROFORMA_LIST_WHITELIST);
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

  // ── Draft create / update ────────────────────────────────────────────────────

  async create(ctx: AuthContext, input: ProformaCreateInput): Promise<Proforma> {
    const totals = computeDocumentTotals(input.lineItems as LineItemInput[]);
    const created = await this.repo.insert(ctx, this.newDraftFields(input, totals));
    await this.emit(this.event("proforma.created", ctx, created.id, { status: "draft" }));
    return created;
  }

  /** Draft-only edit. Totals recomputed; non-draft rejected with INVOICE_NOT_EDITABLE. */
  async update(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    input: ProformaUpdateInput,
  ): Promise<Proforma> {
    const existing = await this.get(ctx, id);
    if (existing.status !== "draft") {
      throw new AppError("INVOICE_NOT_EDITABLE", "Only draft proformas can be edited");
    }
    const { version: _ignored, ...patch } = input;
    void _ignored;

    // Recompute totals whenever line items change; never trust client totals.
    const effectiveLines = (input.lineItems ?? existing.lineItems) as LineItemInput[];
    const totals = computeDocumentTotals(effectiveLines);

    const updated = await this.repo.updateVersioned(ctx, id, expectedVersion, {
      ...patch,
      lineItems: totals.lines,
      subtotalMinor: totals.subtotalMinor,
      discountMinor: totals.discountMinor,
      taxMinor: totals.taxMinor,
      grandTotalMinor: totals.grandTotalMinor,
    } as Partial<Proforma>);
    await this.emit(this.event("proforma.updated", ctx, updated.id));
    return updated;
  }

  // ── Issue (mirrors invoice finalize) ─────────────────────────────────────────

  /**
   * draft → issued: assign the `PRO-` number (once), snapshot the client, lock line
   * items. Re-issue → INVALID_STATE_TRANSITION.
   */
  async issue(ctx: AuthContext, id: string, expectedVersion: number): Promise<Proforma> {
    const existing = await this.get(ctx, id);
    assertTransition<ProformaStatus>(existing.status, "issued", ALLOWED_TRANSITIONS);

    const client = await this.loadClient(ctx, existing.clientId);
    if (!client) throw errors.notFound();
    const snapshot: ClientSnapshot = {
      clientId: client.id,
      displayName: client.displayName,
      legalName: client.legalName ?? null,
      email: client.email ?? null,
      billingAddress: client.billingAddress ?? null,
      vatNumber: client.vatNumber ?? null,
      currency: existing.currency,
      preferredLanguage: client.preferredLanguage ?? null,
      referral: client.referral ?? null,
    };

    const year = Number(existing.issueDate.slice(0, 4));
    const proformaNumber = await this.nextProformaNumber(ctx.accountId, year);

    const issued = await this.repo.replaceState(ctx, id, expectedVersion, {
      status: "issued",
      proformaNumber,
      clientSnapshot: snapshot,
    });
    await this.emit(this.event("proforma.issued", ctx, issued.id, { proformaNumber }));
    return issued;
  }

  // ── Void ────────────────────────────────────────────────────────────────────

  /** Void any non-terminal proforma. */
  async void(ctx: AuthContext, id: string, expectedVersion: number): Promise<Proforma> {
    const existing = await this.get(ctx, id);
    assertTransition<ProformaStatus>(existing.status, "void", ALLOWED_TRANSITIONS);
    const voided = await this.repo.replaceState(ctx, id, expectedVersion, { status: "void" });
    await this.emit(this.event("proforma.void", ctx, voided.id));
    return voided;
  }

  /**
   * Convert an ISSUED proforma into a DRAFT invoice. The full convert:
   *   1. read the proforma — must be `issued` (else INVALID_STATE_TRANSITION);
   *   2. IDEMPOTENT: if `convertedInvoiceId` is already set, load and return that
   *      existing invoice — do NOT mint again, do NOT re-`markConverted` (no
   *      version bump);
   *   3. else mint a DRAFT invoice from the proforma (clientId + lineItems +
   *      notes) via the injected `mintInvoiceFromProforma` port (which calls
   *      `InvoiceService.create`; the invoice re-snapshots the client at finalize);
   *   4. `markConverted` with the new invoice id, then return the minted invoice
   *      plus the updated proforma.
   *
   * A distinct explicit action — NOT auto-on-issue (auto-minting a sequentially
   * numbered legal invoice per proforma would burn numbers). Bank details are not
   * carried here: a proforma has no `bankSnapshot`; the new invoice picks up its
   * own single-account default at create.
   */
  async convert(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
  ): Promise<{ invoice: MintedInvoice; proforma: Proforma }> {
    if (!this.mintInvoiceFromProforma || !this.loadInvoice) {
      throw errors.internal("Proforma convert not configured");
    }
    const existing = await this.get(ctx, id);
    if (existing.status !== "issued") {
      throw new AppError("INVALID_STATE_TRANSITION", "Only an issued proforma can be converted");
    }

    // Idempotent replay: already converted → return the existing invoice untouched.
    if (existing.convertedInvoiceId) {
      const invoice = await this.loadInvoice(ctx, existing.convertedInvoiceId);
      if (!invoice) throw errors.notFound();
      return { invoice, proforma: existing };
    }

    const invoice = await this.mintInvoiceFromProforma(ctx, {
      proformaId: existing.id,
      clientId: existing.clientId,
      currency: existing.currency,
      lineItems: existing.lineItems,
      notes: existing.notes ?? null,
    });
    const proforma = await this.markConverted(ctx, id, expectedVersion, invoice.id);
    return { invoice, proforma };
  }

  /**
   * Record that a proforma was converted to an invoice. This is the
   * in-module half of convert; the actual `Invoice` creation is DEFERRED (it lives
   * in the invoices module, which we cannot edit). The integrator: (1) reads this
   * proforma, (2) creates a draft invoice from its line items + `clientSnapshot`
   * with `sourceType=proforma`, then (3) calls this with the new invoice id. The
   * `PRO-` number is never reused as the `INV-` — the invoice mints its own at
   * finalize. Marking a non-issued proforma → INVALID_STATE_TRANSITION.
   */
  async markConverted(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    invoiceId: string,
  ): Promise<Proforma> {
    const existing = await this.get(ctx, id);
    if (existing.status !== "issued") {
      throw new AppError("INVALID_STATE_TRANSITION", "Only an issued proforma can be converted");
    }
    const converted = await this.repo.replaceState(ctx, id, expectedVersion, {
      convertedInvoiceId: invoiceId,
    });
    await this.emit(this.event("proforma.converted", ctx, converted.id, { invoiceId }));
    return converted;
  }

  // ── Archive / restore ─────────────────────────────────────────────────────────

  async archive(ctx: AuthContext, id: string, expectedVersion: number): Promise<Proforma> {
    const archived = await this.repo.archive(ctx, id, expectedVersion);
    await this.emit(this.event("proforma.updated", ctx, archived.id, { archived: true }));
    return archived;
  }

  async restore(ctx: AuthContext, id: string, expectedVersion: number): Promise<Proforma> {
    const restored = await this.repo.restore(ctx, id, expectedVersion);
    await this.emit(this.event("proforma.updated", ctx, restored.id, { restored: true }));
    return restored;
  }

  /**
   * Soft-delete (DELETE /:id → `deletedAt`), gated by `canPermanentlyDelete`.
   * Mirrors invoices.
   */
  async softDelete(ctx: AuthContext, id: string): Promise<void> {
    this.requireCapability(ctx, "canPermanentlyDelete");
    const existing = await this.repo.findById(ctx, id);
    if (!existing) throw errors.notFound();
    await this.repo.softDelete(ctx, id);
    await this.emit(this.event("proforma.updated", ctx, id, { deleted: true }));
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /** Build the full non-BaseDoc field set for a fresh draft. */
  private newDraftFields(
    input: ProformaCreateInput,
    totals: ReturnType<typeof computeDocumentTotals>,
  ): Omit<Proforma, keyof import("@billy/types").BaseDoc> {
    return {
      clientId: input.clientId,
      projectId: input.projectId ?? null,
      clientSnapshot: null,
      proformaNumber: null,
      currency: input.currency,
      issueDate: input.issueDate,
      expiryDate: input.expiryDate ?? null,
      subject: input.subject ?? null,
      lineItems: totals.lines,
      subtotalMinor: totals.subtotalMinor,
      discountMinor: totals.discountMinor,
      taxMinor: totals.taxMinor,
      grandTotalMinor: totals.grandTotalMinor,
      status: "draft",
      convertedInvoiceId: null,
      notes: input.notes ?? null,
    };
  }

  private event(name: string, ctx: AuthContext, entityId: string, payload?: Record<string, unknown>) {
    return {
      name,
      actorId: ctx.userId,
      entityType: "proforma",
      entityId,
      ...(payload ? { payload } : {}),
    };
  }
}
