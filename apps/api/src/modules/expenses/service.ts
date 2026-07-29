import type { AuthContext, ListMeta } from "@billy/types";
import { AppError } from "@billy/shared";
import { BaseService, type ServiceDeps } from "@/platform/service.js";
import { EXPENSE_LIST_WHITELIST, type ExpenseCreateInput, type ExpenseUpdateInput } from "@/modules/expenses/schema.js";
import type { Expense } from "@/modules/expenses/types.js";
import type { ExpenseRepository } from "@/modules/expenses/repository.js";

/**
 * Expense business logic. All
 * domain rules live here, never in controllers: capability checks,
 * server-authoritative money, the invoiced guard, and `expense.*` events.
 * Every repository call threads the mandatory `ctx`.
 */
export interface ExpenseServiceDeps extends ServiceDeps<Expense> {
  repo: ExpenseRepository;
}

export interface ExpenseListResult {
  items: Expense[];
  meta: ListMeta;
}

export class ExpenseService extends BaseService<Expense> {
  protected override readonly repo: ExpenseRepository;

  constructor(deps: ExpenseServiceDeps) {
    super(deps);
    this.repo = deps.repo;
  }

  async list(ctx: AuthContext, rawQuery: Record<string, string | string[] | undefined>): Promise<ExpenseListResult> {
    const { items, parsed, total } = await this.repo.list(ctx, rawQuery, EXPENSE_LIST_WHITELIST);
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

  async get(ctx: AuthContext, id: string): Promise<Expense> {
    const doc = await this.repo.findById(ctx, id);
    if (!doc) throw notFound();
    return doc;
  }

  /** Create. The server sets the authoritative `amountMinor` from validated input; status starts `draft`. */
  async create(ctx: AuthContext, input: ExpenseCreateInput): Promise<Expense> {
    const data: Omit<Expense, keyof import("@billy/types").BaseDoc> = {
      amountMinor: input.amountMinor,
      currency: input.currency,
      category: input.category,
      date: input.date,
      vendor: input.vendor,
      description: input.description,
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
      projectId: input.projectId ?? null,
      billable: input.billable,
      status: "draft",
      invoicedAt: null,
      invoiceId: null,
    };
    const created = await this.repo.insert(ctx, data);
    await this.emit({
      name: "expense.created",
      actorId: ctx.userId,
      entityType: "expense",
      entityId: created.id,
    });
    return created;
  }

  /** Update mutable fields under optimistic concurrency. Money stays server-authoritative. */
  async update(ctx: AuthContext, id: string, version: number, input: ExpenseUpdateInput): Promise<Expense> {
    const patch: Partial<Expense> = {};
    if (input.amountMinor !== undefined) patch.amountMinor = input.amountMinor;
    if (input.currency !== undefined) patch.currency = input.currency;
    if (input.category !== undefined) patch.category = input.category;
    if (input.date !== undefined) patch.date = input.date;
    if (input.vendor !== undefined) patch.vendor = input.vendor;
    if (input.description !== undefined) patch.description = input.description;
    if (input.clientId !== undefined) patch.clientId = input.clientId ?? undefined;
    if (input.billable !== undefined) patch.billable = input.billable;

    const updated = await this.repo.updateVersioned(ctx, id, version, patch);
    await this.emit({ name: "expense.updated", actorId: ctx.userId, entityType: "expense", entityId: id });
    return updated;
  }

  /** Archive — hidden from default lists, reversible. Uses versioned update. */
  async archive(ctx: AuthContext, id: string, version: number): Promise<Expense> {
    const updated = await this.repo.updateVersioned(ctx, id, version, {
      archivedAt: new Date().toISOString(),
    } as Partial<Expense>);
    await this.emit({ name: "expense.archived", actorId: ctx.userId, entityType: "expense", entityId: id });
    return updated;
  }

  /** Restore an archived expense (repository handles the archived-scope match). */
  async restore(ctx: AuthContext, id: string, version: number): Promise<Expense> {
    const restored = await this.repo.restore(ctx, id, version);
    await this.emit({ name: "expense.restored", actorId: ctx.userId, entityType: "expense", entityId: id });
    return restored;
  }

  /** Soft-delete (DELETE /:id) — admin or member with the capability. */
  async softDelete(ctx: AuthContext, id: string): Promise<void> {
    this.requireCapability(ctx, "canPermanentlyDelete");
    await this.repo.softDelete(ctx, id);
    await this.emit({ name: "expense.deleted", actorId: ctx.userId, entityType: "expense", entityId: id });
  }

  /**
   * Attach a billable expense to a draft invoice. The guard is
   * on the durable fact `invoiceId != null` — an already-invoiced expense →
   * EXPENSE_ALREADY_INVOICED, regardless of status. Runs inside the transaction
   * boundary; sets `invoiceId` + `invoicedAt` + `status`, then emits.
   */
  async markInvoiced(ctx: AuthContext, id: string, version: number, invoiceId: string): Promise<Expense> {
    return this.withTransaction(async () => {
      const existing = await this.repo.findById(ctx, id);
      if (!existing) throw notFound();
      if (existing.invoiceId != null) {
        throw new AppError("EXPENSE_ALREADY_INVOICED", "Expense has already been invoiced");
      }
      const updated = await this.repo.updateVersioned(ctx, id, version, {
        invoiceId,
        invoicedAt: new Date().toISOString(),
        status: "invoiced",
      } as Partial<Expense>);
      await this.emit({
        name: "expense.invoiced",
        actorId: ctx.userId,
        entityType: "expense",
        entityId: id,
        payload: { invoiceId },
      });
      return updated;
    });
  }
}

const notFound = (): AppError => {
  return new AppError("RESOURCE_NOT_FOUND", "Expense not found");
};
