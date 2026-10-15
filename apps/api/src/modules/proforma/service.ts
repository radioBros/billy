import type { AuthContext, ListMeta } from "@billy/types";
import { AppError, DEFAULT_PAYMENT_TERM_DAYS, errors } from "@billy/shared";
import { addDaysIso, daysBetweenIso } from "@billy/einvoice";
import { BaseService, assertTransition, type ServiceDeps } from "@/platform/service.js";
import { computeDocumentTotals, type LineItemInput } from "@/platform/money.js";
import type { ProformaRepository } from "@/modules/proforma/repository.js";
import { PROFORMA_LIST_WHITELIST, type ProformaCreateInput, type ProformaUpdateInput } from "@/modules/proforma/schema.js";
import type { BankSnapshot, ClientSnapshot, Proforma, ProformaStatus } from "@/modules/proforma/types.js";

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
 * Convert → real `Invoice` goes through the injected `mintInvoiceFromProforma`
 * port (wired in routes.ts to `InvoiceService.create`), guarded by a version-checked
 * claim so a retry/double-click can never mint twice (see `convert`).
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
 * A named bank account from business settings (multi-bank). Mirrors the invoices
 * module's `BankAccountRecord` (kept local so the modules stay decoupled).
 */
export interface BankAccountRecord {
  id: string;
  label: string;
  details: string;
}

/**
 * Injected loader for the business's bank accounts (multi-bank). Returns the full
 * list so the service can resolve the chosen id into a snapshot. OPTIONAL — when
 * unwired, no bank is ever snapshotted.
 */
export type LoadBankAccounts = (ctx: AuthContext) => Promise<BankAccountRecord[]>;

/**
 * The proforma data handed to the invoice-minting port on convert. Carries
 * everything the invoices module needs to build a DRAFT invoice. The mint impl
 * calls `InvoiceService.create` — which re-snapshots the client at finalize from
 * `clientId` — so we pass the id, consistent with the normal invoice flow.
 *  - `issueDate` = today (account timezone); `dueDate` = issueDate + the proforma's
 *    issue→expiry gap, or + DEFAULT_PAYMENT_TERM_DAYS when it has no expiry.
 *  - `lineItems` are RAW inputs (incl. the FatturaPA `nature`); the invoice recomputes.
 *  - `bankSnapshot` is the proforma's chosen bank — the invoice must print the same one.
 */
export interface ProformaConvertData {
  proformaId: string;
  clientId: string;
  currency: string;
  issueDate: string;
  dueDate: string;
  lineItems: LineItemInput[];
  notes?: string | null;
  subject?: string | null;
  projectId?: string | null;
  bankSnapshot?: BankSnapshot | null;
}

/** "Today" (YYYY-MM-DD) for the caller's account — the routes wire the business timezone. */
export type TodayForAccount = (ctx: AuthContext) => Promise<string>;

/** A convert claim older than this is considered abandoned (crashed request) and may be retaken. */
const CONVERT_CLAIM_TTL_MS = 2 * 60 * 1000;

const nowIso = (): string => new Date().toISOString();

/** Strip a computed line back to its raw inputs — keeps every input field, incl. `nature`. */
const toRawLine = (l: LineItemInput): LineItemInput => {
  const raw: LineItemInput = { description: l.description, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor };
  if (l.discountRate != null) raw.discountRate = l.discountRate;
  if (l.taxRate != null) raw.taxRate = l.taxRate;
  if (l.nature != null) raw.nature = l.nature;
  return raw;
};

/** Invoice due date for a converted proforma (see ProformaConvertData). */
export const convertedDueDate = (proforma: Pick<Proforma, "issueDate" | "expiryDate">, invoiceIssueDate: string): string => {
  const gap = proforma.expiryDate ? Math.max(0, daysBetweenIso(proforma.issueDate, proforma.expiryDate)) : DEFAULT_PAYMENT_TERM_DAYS;
  return addDaysIso(invoiceIssueDate, gap);
};

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
  /** Business bank-accounts loader (multi-bank). Optional — omit to disable bank snapshots. */
  loadBankAccounts?: LoadBankAccounts;
  /** Account-local "today" for the converted invoice's issue date. Optional — defaults to UTC today. */
  today?: TodayForAccount;
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
  private readonly loadBankAccounts?: LoadBankAccounts;
  private readonly today: TodayForAccount;

  constructor(deps: ProformaServiceDeps) {
    super(deps);
    this.repo = deps.repo;
    this.loadClient = deps.loadClient;
    this.nextProformaNumber = deps.nextProformaNumber;
    this.mintInvoiceFromProforma = deps.mintInvoiceFromProforma;
    this.loadInvoice = deps.loadInvoice;
    this.loadBankAccounts = deps.loadBankAccounts;
    this.today = deps.today ?? (async () => nowIso().slice(0, 10));
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
    const bankSnapshot = await this.resolveBankSnapshot(ctx, input.bankAccountId);
    const created = await this.repo.insert(ctx, this.newDraftFields(input, totals, bankSnapshot));
    await this.emit(this.event("proforma.created", ctx, created.id, { status: "draft" }));
    return created;
  }

  /**
   * Resolve the chosen bank account into an immutable `bankSnapshot` (multi-bank).
   * EXPLICIT-ONLY (deliberate divergence from invoices): a provided id → that
   * account; otherwise → null. Unlike the invoices service, this does NOT auto-pick
   * a sole account when no id is given — that auto-attach is a FORM behaviour
   * (ProformaForm defaults `bankAccountId` to the single account before submit). The
   * `bankAccountId` is never persisted — only the resolved snapshot is.
   */
  private async resolveBankSnapshot(
    ctx: AuthContext,
    bankAccountId: string | undefined,
  ): Promise<BankSnapshot | null> {
    if (!this.loadBankAccounts || bankAccountId == null) return null;
    const accounts = await this.loadBankAccounts(ctx);
    const chosen = accounts.find((a) => a.id === bankAccountId);
    return chosen ? { label: chosen.label, details: chosen.details } : null;
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
   * Convert an ISSUED proforma into a DRAFT invoice:
   *   1. read the proforma — must be `issued` (else INVALID_STATE_TRANSITION);
   *   2. IDEMPOTENT: if `convertedInvoiceId` is already set, load and return that
   *      existing invoice — no mint, no version bump;
   *   3. CLAIM: a version-guarded write stamps `convertingAt` BEFORE minting, so a
   *      concurrent/double-submitted convert loses with VERSION_CONFLICT instead of
   *      minting a duplicate (a live claim by someone else → VERSION_CONFLICT too;
   *      an abandoned claim older than the TTL may be retaken);
   *   4. mint a DRAFT invoice via the injected port: issue date = today (account
   *      timezone), due date = + the proforma's issue→expiry gap (else + the default
   *      payment term), subject/projectId/notes, raw lines incl. `nature`, and the
   *      proforma's chosen bank. A failed mint releases the claim;
   *   5. `markConverted` (on the claimed version) links the invoice + clears the claim.
   *
   * A distinct explicit action — NOT auto-on-issue (auto-minting a sequentially
   * numbered legal invoice per proforma would burn numbers).
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

    if (existing.convertingAt && Date.now() - Date.parse(existing.convertingAt) < CONVERT_CLAIM_TTL_MS) {
      throw errors.versionConflict("This proforma is already being converted");
    }
    // Version-guarded claim: exactly one request wins; the loser never mints.
    const claimed = await this.repo.replaceState(ctx, id, expectedVersion, { convertingAt: nowIso() });

    const issueDate = await this.today(ctx);
    let invoice: MintedInvoice;
    try {
      invoice = await this.mintInvoiceFromProforma(ctx, {
        proformaId: existing.id,
        clientId: existing.clientId,
        currency: existing.currency,
        issueDate,
        dueDate: convertedDueDate(existing, issueDate),
        lineItems: existing.lineItems.map(toRawLine),
        notes: existing.notes ?? null,
        subject: existing.subject ?? null,
        projectId: existing.projectId ?? null,
        bankSnapshot: existing.bankSnapshot ?? null,
      });
    } catch (err) {
      // Release the claim so the user can retry right away (best effort).
      await this.repo.replaceState(ctx, id, claimed.version, { convertingAt: null }).catch(() => undefined);
      throw err;
    }
    try {
      const proforma = await this.markConverted(ctx, id, claimed.version, invoice.id);
      return { invoice, proforma };
    } catch (err) {
      this.logger.error({ err, proformaId: id, invoiceId: invoice.id }, "proforma.convert: invoice minted but linking it failed");
      const code = err instanceof AppError ? err.code : "INTERNAL_ERROR";
      throw new AppError(code, `Draft invoice ${invoice.id} was created but could not be linked to the proforma`, {
        details: { invoiceId: invoice.id },
      });
    }
  }

  /**
   * Record that a proforma was converted to an invoice (links `convertedInvoiceId`
   * and clears any convert claim). The `PRO-` number is never reused as the `INV-`
   * — the invoice mints its own at finalize. Marking a non-issued proforma →
   * INVALID_STATE_TRANSITION.
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
      convertingAt: null,
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
    bankSnapshot: BankSnapshot | null,
  ): Omit<Proforma, keyof import("@billy/types").BaseDoc> {
    return {
      clientId: input.clientId,
      projectId: input.projectId ?? null,
      clientSnapshot: null,
      proformaNumber: null,
      currency: input.currency,
      bankSnapshot,
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
      convertingAt: null,
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
