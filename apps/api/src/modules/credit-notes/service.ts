import type { AuthContext, ListMeta } from "@billy/types";
import { AppError, errors } from "@billy/shared";
import { BaseService, assertTransition, type ServiceDeps } from "@/platform/service.js";
import { computeDocumentTotals, type LineItemInput } from "@/platform/money.js";
import type { CreditNoteRepository } from "@/modules/credit-notes/repository.js";
import {
  CREDIT_NOTE_LIST_WHITELIST,
  type CreditNoteCreateInput,
  type CreditNoteUpdateInput,
} from "@/modules/credit-notes/schema.js";
import type { ClientSnapshot, CreditNote, CreditNoteStatus } from "@/modules/credit-notes/types.js";

/**
 * CreditNote business logic. All
 * logic lives here, never in controllers. Owns: draft create/update,
 * issue (number + snapshot + lock), void, and `creditNote.*` events. Every repo
 * call threads `authContext`.
 *
 * Server-authority invariants:
 *  - Totals recomputed from `lineItems` via `computeDocumentTotals` — client totals
 *    ignored. Same shared util as quotes/invoices/recurring.
 *  - `creditNoteNumber` assigned once, inside `issue`; the editor can never set it.
 *  - Issued credit notes are immutable (only void/archive/restore).
 *
 * DEFERRED (see types.ts): transactional `amountApplied`, derived effective-
 * outstanding, currency-match to the credited invoice, PDF, send, notifications,
 * dashboard. Those require touching other modules.
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

/** Injected credit-note-number allocator (issue). Real impl uses platform numbering. */
export type NextCreditNoteNumber = (accountId: string, year: number) => Promise<string>;

export interface CreditNoteServiceDeps extends ServiceDeps<CreditNote> {
  repo: CreditNoteRepository;
  loadClient: LoadClient;
  nextCreditNoteNumber: NextCreditNoteNumber;
}

/** Explicit-action transitions only. */
const ALLOWED_TRANSITIONS: Partial<Record<CreditNoteStatus, readonly CreditNoteStatus[]>> = {
  draft: ["issued", "void"],
  issued: ["void"],
};

export class CreditNoteService extends BaseService<CreditNote> {
  protected override readonly repo: CreditNoteRepository;
  private readonly loadClient: LoadClient;
  private readonly nextCreditNoteNumber: NextCreditNoteNumber;

  constructor(deps: CreditNoteServiceDeps) {
    super(deps);
    this.repo = deps.repo;
    this.loadClient = deps.loadClient;
    this.nextCreditNoteNumber = deps.nextCreditNoteNumber;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  async get(ctx: AuthContext, id: string): Promise<CreditNote> {
    const doc = await this.repo.findById(ctx, id);
    if (!doc) throw errors.notFound();
    return doc;
  }

  async list(
    ctx: AuthContext,
    rawQuery: Record<string, string | string[] | undefined>,
  ): Promise<{ items: CreditNote[]; meta: ListMeta }> {
    const { items, parsed, total } = await this.repo.list(ctx, rawQuery, CREDIT_NOTE_LIST_WHITELIST);
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

  async create(ctx: AuthContext, input: CreditNoteCreateInput): Promise<CreditNote> {
    const totals = computeDocumentTotals(input.lineItems as LineItemInput[]);
    const created = await this.repo.insert(ctx, this.newDraftFields(input, totals));
    await this.emit(this.event("creditNote.created", ctx, created.id, { status: "draft" }));
    return created;
  }

  /** Draft-only edit. Totals recomputed; non-draft rejected with INVOICE_NOT_EDITABLE. */
  async update(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    input: CreditNoteUpdateInput,
  ): Promise<CreditNote> {
    const existing = await this.get(ctx, id);
    if (existing.status !== "draft") {
      throw new AppError("INVOICE_NOT_EDITABLE", "Only draft credit notes can be edited");
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
    } as Partial<CreditNote>);
    await this.emit(this.event("creditNote.updated", ctx, updated.id));
    return updated;
  }

  // ── Issue (mirrors invoice finalize) ─────────────────────────────────────

  /**
   * draft → issued: assign the `CN-` number (once), snapshot the client, lock line
   * items. Re-issue → INVALID_STATE_TRANSITION (an issued credit note is immutable;
   * the invoices module has a dedicated INVOICE_ALREADY_FINALIZED code, but there is
   * no credit-note-specific code and we cannot add one — the generic transition code
   * is the correct fit here).
   */
  async issue(ctx: AuthContext, id: string, expectedVersion: number): Promise<CreditNote> {
    const existing = await this.get(ctx, id);
    assertTransition<CreditNoteStatus>(existing.status, "issued", ALLOWED_TRANSITIONS);

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
    const creditNoteNumber = await this.nextCreditNoteNumber(ctx.accountId, year);

    const issued = await this.repo.replaceState(ctx, id, expectedVersion, {
      status: "issued",
      creditNoteNumber,
      clientSnapshot: snapshot,
    });
    await this.emit(this.event("creditNote.issued", ctx, issued.id, { creditNoteNumber }));
    return issued;
  }

  // ── Void ────────────────────────────────────────────────────────────────

  /** Void any non-terminal credit note. The row is retained for audit. */
  async void(ctx: AuthContext, id: string, expectedVersion: number): Promise<CreditNote> {
    const existing = await this.get(ctx, id);
    assertTransition<CreditNoteStatus>(existing.status, "void", ALLOWED_TRANSITIONS);
    const voided = await this.repo.replaceState(ctx, id, expectedVersion, { status: "void" });
    await this.emit(this.event("creditNote.void", ctx, voided.id));
    return voided;
  }

  // ── Archive / restore ─────────────────────────────────────────────────────────

  async archive(ctx: AuthContext, id: string, expectedVersion: number): Promise<CreditNote> {
    const archived = await this.repo.archive(ctx, id, expectedVersion);
    await this.emit(this.event("creditNote.updated", ctx, archived.id, { archived: true }));
    return archived;
  }

  async restore(ctx: AuthContext, id: string, expectedVersion: number): Promise<CreditNote> {
    const restored = await this.repo.restore(ctx, id, expectedVersion);
    await this.emit(this.event("creditNote.updated", ctx, restored.id, { restored: true }));
    return restored;
  }

  /**
   * Soft-delete (DELETE /:id → `deletedAt`), gated by `canPermanentlyDelete`
   * Financial records (issued credit notes) are never hard-deleted;
   * the soft-delete only hides the doc. Mirrors invoices.
   */
  async softDelete(ctx: AuthContext, id: string): Promise<void> {
    this.requireCapability(ctx, "canPermanentlyDelete");
    const existing = await this.repo.findById(ctx, id);
    if (!existing) throw errors.notFound();
    await this.repo.softDelete(ctx, id);
    await this.emit(this.event("creditNote.updated", ctx, id, { deleted: true }));
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /** Build the full non-BaseDoc field set for a fresh draft. */
  private newDraftFields(
    input: CreditNoteCreateInput,
    totals: ReturnType<typeof computeDocumentTotals>,
  ): Omit<CreditNote, keyof import("@billy/types").BaseDoc> {
    return {
      clientId: input.clientId,
      projectId: input.projectId ?? null,
      clientSnapshot: null,
      creditNoteNumber: null,
      creditedInvoiceId: input.creditedInvoiceId,
      creditedInvoiceNumber: null,
      currency: input.currency,
      issueDate: input.issueDate,
      subject: input.subject ?? null,
      lineItems: totals.lines,
      subtotalMinor: totals.subtotalMinor,
      discountMinor: totals.discountMinor,
      taxMinor: totals.taxMinor,
      grandTotalMinor: totals.grandTotalMinor,
      status: "draft",
      reason: input.reason ?? null,
      notes: input.notes ?? null,
    };
  }

  private event(name: string, ctx: AuthContext, entityId: string, payload?: Record<string, unknown>) {
    return {
      name,
      actorId: ctx.userId,
      entityType: "creditNote",
      entityId,
      ...(payload ? { payload } : {}),
    };
  }
}
