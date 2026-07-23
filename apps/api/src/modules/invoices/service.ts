import type { AuthContext, ListMeta } from "@billy/types";
import { AppError, errors } from "@billy/shared";
import { BaseService, assertTransition, type ServiceDeps } from "@/platform/service.js";
import { computeDocumentTotals, type LineItemInput } from "@/platform/money.js";
import type { ShareTokenStore } from "@/modules/public-links/share-tokens.js";
import type { InvoiceRepository } from "@/modules/invoices/repository.js";
import {
  INVOICE_LIST_WHITELIST,
  type AddPaymentInput,
  type CreateFromQuoteInput,
  type InvoiceCreateInput,
  type InvoiceUpdateInput,
} from "@/modules/invoices/schema.js";
import type { BankSnapshot, ClientSnapshot, Invoice, InvoiceStatus, Payment } from "@/modules/invoices/types.js";

/**
 * Invoice business logic. All logic lives here, never in controllers. Owns: draft
 * create/update, finalize (number + snapshot + lock), payments (transactional
 * total recompute), void, createFromQuote, and `invoice.*` events. Every repo call
 * threads `authContext`.
 *
 * Server-authority invariants:
 *  - Totals recomputed from `lineItems` via `computeDocumentTotals` — client totals
 *    ignored.
 *  - `amountPaidMinor`/`amountDueMinor` maintained ONLY inside `withTransaction` on
 *    payment mutations; the editor cannot touch them.
 *  - `partially_paid`/`paid` are DERIVED from amountPaid vs grandTotal, not user-set
 *    — so a single full payment can jump finalized→paid without
 *    a linear transition guard.
 */

/** Injected client read (finalize snapshots the client by reading the clients collection). */
export type LoadClient = (ctx: AuthContext, clientId: string) => Promise<ClientRecord | null>;

/** Minimal client shape finalize needs to build a snapshot. */
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

/** Injected invoice-number allocator (finalize). Real impl uses platform numbering. */
export type NextInvoiceNumber = (accountId: string, year: number) => Promise<string>;

/** A named bank account from business settings (multi-bank). */
export interface BankAccountRecord {
  id: string;
  label: string;
  details: string;
}

/**
 * Injected loader for the business's bank accounts (multi-bank). Returns the full
 * list so the service owns the "explicit id / single-default / none→null"
 * branching (mirror how `loadClient` returns the raw record and the service builds
 * the snapshot). OPTIONAL — when unwired, no bank is ever snapshotted.
 */
export type LoadBankAccounts = (ctx: AuthContext) => Promise<BankAccountRecord[]>;

export interface InvoiceServiceDeps extends ServiceDeps<Invoice> {
  repo: InvoiceRepository;
  loadClient: LoadClient;
  nextInvoiceNumber: NextInvoiceNumber;
  /** settings.invoicing.overpaymentToleranceMinor (default 0). */
  overpaymentToleranceMinor?: number;
  /** Hashed share-token store; required for `/share`. */
  shareTokens?: ShareTokenStore;
  /** Business bank-accounts loader (multi-bank). Optional — omit to disable bank snapshots. */
  loadBankAccounts?: LoadBankAccounts;
}

/** Explicit-action transitions only. Paid-family is derived, not routed here. */
const ALLOWED_TRANSITIONS: Partial<Record<InvoiceStatus, readonly InvoiceStatus[]>> = {
  draft: ["scheduled", "finalized", "void"],
  scheduled: ["draft", "finalized", "void"], // unschedule → draft; worker tick → finalized
  finalized: ["void"],
  sent: ["void"],
  partially_paid: ["void"],
};

export class InvoiceService extends BaseService<Invoice> {
  protected override readonly repo: InvoiceRepository;
  private readonly loadClient: LoadClient;
  private readonly nextInvoiceNumber: NextInvoiceNumber;
  private readonly toleranceMinor: number;
  private readonly shareTokens?: ShareTokenStore;
  private readonly loadBankAccounts?: LoadBankAccounts;

  constructor(deps: InvoiceServiceDeps) {
    super(deps);
    this.repo = deps.repo;
    this.loadClient = deps.loadClient;
    this.nextInvoiceNumber = deps.nextInvoiceNumber;
    this.toleranceMinor = deps.overpaymentToleranceMinor ?? 0;
    this.shareTokens = deps.shareTokens;
    this.loadBankAccounts = deps.loadBankAccounts;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  async get(ctx: AuthContext, id: string): Promise<Invoice> {
    const doc = await this.repo.findById(ctx, id);
    if (!doc) throw errors.notFound();
    return doc;
  }

  async list(
    ctx: AuthContext,
    rawQuery: Record<string, string | string[] | undefined>,
  ): Promise<{ items: Invoice[]; meta: ListMeta }> {
    const { items, parsed, total } = await this.repo.list(ctx, rawQuery, INVOICE_LIST_WHITELIST);
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

  async create(ctx: AuthContext, input: InvoiceCreateInput): Promise<Invoice> {
    const totals = computeDocumentTotals(input.lineItems as LineItemInput[]);
    const bankSnapshot = await this.resolveBankSnapshot(ctx, input.bankAccountId);
    const created = await this.repo.insert(ctx, this.newDraftFields(input, totals, null, null, bankSnapshot));
    await this.emit(this.event("invoice.created", ctx, created.id, { status: "draft" }));
    return created;
  }

  /**
   * Resolve the chosen bank account into an immutable `bankSnapshot` (multi-bank).
   * Owns the branching: a provided id → that account; else exactly one
   * account → default to it; else (none, ambiguous, or loader unwired) → null. The
   * `bankAccountId` is never persisted — only the resolved snapshot is.
   */
  private async resolveBankSnapshot(
    ctx: AuthContext,
    bankAccountId: string | undefined,
  ): Promise<BankSnapshot | null> {
    if (!this.loadBankAccounts) return null;
    const accounts = await this.loadBankAccounts(ctx);
    let chosen: BankAccountRecord | undefined;
    if (bankAccountId != null) {
      chosen = accounts.find((a) => a.id === bankAccountId);
    } else if (accounts.length === 1) {
      chosen = accounts[0];
    }
    return chosen ? { label: chosen.label, details: chosen.details } : null;
  }

  /** Draft-only edit. Totals recomputed; non-draft rejected with INVOICE_NOT_EDITABLE. */
  async update(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    input: InvoiceUpdateInput,
  ): Promise<Invoice> {
    const existing = await this.get(ctx, id);
    if (existing.status !== "draft") {
      throw new AppError("INVOICE_NOT_EDITABLE", "Only draft invoices can be edited");
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
      // amountDue tracks grandTotal while unpaid (a draft has no payments).
      amountDueMinor: totals.grandTotalMinor - existing.amountPaidMinor,
    } as Partial<Invoice>);
    await this.emit(this.event("invoice.updated", ctx, updated.id));
    return updated;
  }

  // ── Finalize ──────────────────────────────────────────────────────────────────

  /**
   * draft → finalized: assign the invoice number (once), snapshot the client, lock
   * line items. Re-finalize → INVOICE_ALREADY_FINALIZED.
   */
  async finalize(ctx: AuthContext, id: string, expectedVersion: number): Promise<Invoice> {
    const existing = await this.get(ctx, id);
    if (existing.status !== "draft" || existing.invoiceNumber) {
      throw new AppError("INVOICE_ALREADY_FINALIZED", "Invoice is already finalized");
    }
    assertTransition<InvoiceStatus>(existing.status, "finalized", ALLOWED_TRANSITIONS);

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
    const invoiceNumber = await this.nextInvoiceNumber(ctx.accountId, year);

    const finalized = await this.repo.replaceState(ctx, id, expectedVersion, {
      status: "finalized",
      invoiceNumber,
      clientSnapshot: snapshot,
    });
    await this.emit(this.event("invoice.finalized", ctx, finalized.id, { invoiceNumber }));
    return finalized;
  }

  // ── Scheduled send ────────────────────────────────────────────────────────────

  /**
   * Schedule a DRAFT invoice to be finalized + sent on a future date. The invoice
   * stays a pre-finalized draft (NO number) — the worker's scheduled-send tick
   * finalizes it on `scheduledSendDate` (assigning the number THEN, so numbering
   * stays ordered by issue date, a tax-compliance requirement). draft→scheduled.
   */
  async schedule(ctx: AuthContext, id: string, expectedVersion: number, scheduledSendDate: string): Promise<Invoice> {
    const existing = await this.get(ctx, id);
    if (existing.status !== "draft" || existing.invoiceNumber) {
      throw new AppError("INVALID_STATE_TRANSITION", "Only an un-finalized draft can be scheduled");
    }
    assertTransition<InvoiceStatus>(existing.status, "scheduled", ALLOWED_TRANSITIONS);
    const updated = await this.repo.replaceState(ctx, id, expectedVersion, {
      status: "scheduled",
      scheduledSendDate,
    });
    await this.emit(this.event("invoice.scheduled", ctx, updated.id, { scheduledSendDate }));
    return updated;
  }

  /** Cancel a schedule — scheduled→draft, clears the send date. */
  async unschedule(ctx: AuthContext, id: string, expectedVersion: number): Promise<Invoice> {
    const existing = await this.get(ctx, id);
    if (existing.status !== "scheduled") {
      throw new AppError("INVALID_STATE_TRANSITION", "Invoice is not scheduled");
    }
    assertTransition<InvoiceStatus>(existing.status, "draft", ALLOWED_TRANSITIONS);
    const updated = await this.repo.replaceState(ctx, id, expectedVersion, {
      status: "draft",
      scheduledSendDate: null,
    });
    await this.emit(this.event("invoice.unscheduled", ctx, updated.id, {}));
    return updated;
  }

  // ── Payments ──────────────────────────────────────────────────────────────────

  /**
   * Add a payment inside a transaction: append to the embedded array, recompute
   * `amountPaid`/`amountDue` and status. Guards: over-tolerance → PAYMENT_EXCEEDS_TOTAL;
   * paying a paid invoice → INVOICE_ALREADY_PAID; only finalized/sent/partially_paid
   * accept payments.
   */
  async addPayment(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    input: AddPaymentInput,
  ): Promise<Invoice> {
    return this.withTransaction(async () => {
      const inv = await this.get(ctx, id);
      this.assertPayable(inv);

      const payment: Payment = {
        id: cryptoRandomId(),
        amountMinor: input.amountMinor,
        date: input.date,
        method: input.method,
        reference: input.reference ?? null,
        createdAt: new Date().toISOString(),
      };
      const payments = [...inv.payments, payment];
      const amountPaidMinor = sumPayments(payments);

      // Overpayment guard on the NEW cumulative total.
      if (amountPaidMinor > inv.grandTotalMinor + this.toleranceMinor) {
        throw new AppError("PAYMENT_EXCEEDS_TOTAL", "Payment exceeds invoice total beyond tolerance");
      }

      const status = deriveStatus(amountPaidMinor, inv.grandTotalMinor, this.toleranceMinor);
      const saved = await this.repo.replaceState(ctx, id, expectedVersion, {
        payments,
        amountPaidMinor,
        amountDueMinor: inv.grandTotalMinor - amountPaidMinor,
        status,
      });
      await this.emit(this.event("invoice.payment_added", ctx, saved.id, { paymentId: payment.id }));
      if (status === "paid") await this.emit(this.event("invoice.paid", ctx, saved.id));
      return saved;
    });
  }

  /**
   * Remove a payment inside a transaction: recompute totals + status. On dropping
   * to zero the status reverts to `finalized` (not `sent` — no send route in this
   * slice). Payment rows are removed here (embedded); audit trail is carried by the
   * emitted event.
   */
  async removePayment(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    paymentId: string,
  ): Promise<Invoice> {
    return this.withTransaction(async () => {
      const inv = await this.get(ctx, id);
      const removed = inv.payments.find((p) => p.id === paymentId);
      if (!removed) throw errors.notFound();

      const payments = inv.payments.filter((p) => p.id !== paymentId);
      const amountPaidMinor = sumPayments(payments);
      // A voided invoice retains its payments for audit; removing
      // one must NOT resurrect it — preserve `void`, otherwise re-derive from amounts.
      const status =
        inv.status === "void" ? "void" : deriveStatus(amountPaidMinor, inv.grandTotalMinor, this.toleranceMinor);

      const saved = await this.repo.replaceState(ctx, id, expectedVersion, {
        payments,
        amountPaidMinor,
        amountDueMinor: inv.grandTotalMinor - amountPaidMinor,
        status,
      });
      await this.emit(
        this.event("invoice.payment_removed", ctx, saved.id, {
          paymentId,
          amountMinor: removed.amountMinor, // before-state for audit
        }),
      );
      return saved;
    });
  }

  // ── Void ──────────────────────────────────────────────────────────────────────

  /** Void any non-terminal invoice. Voiding a `paid` invoice → INVOICE_ALREADY_PAID. */
  async void(ctx: AuthContext, id: string, expectedVersion: number): Promise<Invoice> {
    const existing = await this.get(ctx, id);
    if (existing.status === "paid") {
      throw new AppError("INVOICE_ALREADY_PAID", "Cannot void a fully-paid invoice");
    }
    assertTransition<InvoiceStatus>(existing.status, "void", ALLOWED_TRANSITIONS);
    const voided = await this.repo.replaceState(ctx, id, expectedVersion, { status: "void" });
    await this.emit(this.event("invoice.void", ctx, voided.id));
    return voided;
  }

  // ── createFromQuote (quote conversion) ─────────────────────────────────────────

  /**
   * Build a new DRAFT invoice from an accepted quote (task: matches the quotes
   * module's `ConvertToInvoicePayload`). Snapshot comes from the payload (already
   * captured on the quote); records `convertedFromQuoteId`. No number yet — assigned
   * at finalize.
   */
  async createFromQuote(ctx: AuthContext, input: CreateFromQuoteInput): Promise<Invoice> {
    const totals = computeDocumentTotals(input.lineItems as LineItemInput[]);
    const today = new Date().toISOString().slice(0, 10);
    const draftInput: InvoiceCreateInput = {
      clientId: input.clientId,
      currency: input.currency,
      issueDate: input.issueDate ?? today,
      dueDate: input.dueDate ?? input.issueDate ?? today,
      lineItems: input.lineItems,
      notes: input.notes ?? null,
    };
    const created = await this.repo.insert(
      ctx,
      this.newDraftFields(draftInput, totals, input.clientSnapshot as ClientSnapshot, input.quoteId, null),
    );
    await this.emit(this.event("invoice.created", ctx, created.id, { convertedFromQuoteId: input.quoteId }));
    return created;
  }

  // ── Public share token (mirror of quotes' mint) ──────────────────────────────

  /**
   * Mint a 256-bit public share token so the no-auth `/public/invoices/:token`
   * surface can resolve. The RAW token is stored HASHED in the `shareTokens`
   * collection (never on the invoice doc) and returned once for the share URL.
   *
   * ROTATES on re-share (supersedes any prior token → old link dies). This
   * REPLACES the previous idempotent-return-existing behavior: a hashed store
   * cannot hand back a prior raw token, so a second `/share` mints fresh.
   * Requires a wired `shareTokens` store.
   */
  async mintPublicToken(ctx: AuthContext, invoiceId: string): Promise<{ invoice: Invoice; token: string }> {
    if (!this.shareTokens) throw errors.internal("Share-token store not configured");
    const inv = await this.get(ctx, invoiceId);
    const token = await this.shareTokens.mint("invoice", invoiceId, ctx.userId);
    await this.emit(this.event("invoice.updated", ctx, inv.id, { shared: true }));
    return { invoice: inv, token };
  }

  // ── Archive / restore ─────────────────────────────────────────────────────────

  async archive(ctx: AuthContext, id: string, expectedVersion: number): Promise<Invoice> {
    const archived = await this.repo.archive(ctx, id, expectedVersion);
    await this.emit(this.event("invoice.updated", ctx, archived.id, { archived: true }));
    return archived;
  }

  async restore(ctx: AuthContext, id: string, expectedVersion: number): Promise<Invoice> {
    const restored = await this.repo.restore(ctx, id, expectedVersion);
    await this.emit(this.event("invoice.updated", ctx, restored.id, { restored: true }));
    return restored;
  }

  /**
   * Soft-delete (DELETE /:id → `deletedAt`), gated by `canPermanentlyDelete`.
   * Financial records (finalized invoices) are never hard-deleted;
   * the soft-delete only hides the doc.
   */
  async softDelete(ctx: AuthContext, id: string): Promise<void> {
    this.requireCapability(ctx, "canPermanentlyDelete");
    const existing = await this.repo.findById(ctx, id);
    if (!existing) throw errors.notFound();
    await this.repo.softDelete(ctx, id);
    await this.emit(this.event("invoice.updated", ctx, id, { deleted: true }));
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private assertPayable(inv: Invoice): void {
    if (inv.status === "paid") {
      throw new AppError("INVOICE_ALREADY_PAID", "Invoice is already fully paid");
    }
    if (inv.status !== "finalized" && inv.status !== "sent" && inv.status !== "partially_paid") {
      throw new AppError("INVALID_STATE_TRANSITION", `Cannot add a payment to a ${inv.status} invoice`);
    }
  }

  /** Build the full non-BaseDoc field set for a fresh draft. */
  private newDraftFields(
    input: InvoiceCreateInput,
    totals: ReturnType<typeof computeDocumentTotals>,
    clientSnapshot: ClientSnapshot | null,
    convertedFromQuoteId: string | null,
    bankSnapshot: BankSnapshot | null,
  ): Omit<Invoice, keyof import("@billy/types").BaseDoc> {
    return {
      clientId: input.clientId,
      projectId: input.projectId ?? null,
      clientSnapshot,
      invoiceNumber: null,
      currency: input.currency,
      bankSnapshot,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      subject: input.subject ?? null,
      lineItems: totals.lines,
      subtotalMinor: totals.subtotalMinor,
      discountMinor: totals.discountMinor,
      taxMinor: totals.taxMinor,
      grandTotalMinor: totals.grandTotalMinor,
      amountPaidMinor: 0,
      amountDueMinor: totals.grandTotalMinor,
      payments: [],
      status: "draft",
      convertedFromQuoteId,
      notes: input.notes ?? null,
    };
  }

  private event(name: string, ctx: AuthContext, entityId: string, payload?: Record<string, unknown>) {
    return {
      name,
      actorId: ctx.userId,
      entityType: "invoice",
      entityId,
      ...(payload ? { payload } : {}),
    };
  }
}

const sumPayments = (payments: readonly Payment[]): number => {
  return payments.reduce((a, p) => a + p.amountMinor, 0);
};

const deriveStatus = (amountPaidMinor: number, grandTotalMinor: number, _toleranceMinor: number): InvoiceStatus => {
  if (amountPaidMinor <= 0) return "finalized";
  if (amountPaidMinor >= grandTotalMinor) return "paid";
  return "partially_paid";
};

const cryptoRandomId = (): string => {
  return `pay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};
