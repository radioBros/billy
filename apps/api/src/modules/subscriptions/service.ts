import type { AuthContext } from "@billy/types";
import { AppError } from "@billy/shared";
import { BaseService, assertTransition, type ServiceDeps } from "@/platform/service.js";
import type { Subscription, SubscriptionInterval, SubscriptionStatus } from "@/modules/subscriptions/types.js";
import type { SubscriptionRepository } from "@/modules/subscriptions/repository.js";
import type { SubscriptionCreateInput, SubscriptionUpdateInput } from "@/modules/subscriptions/schema.js";

/**
 * Subscription business logic. All domain rules
 * live here, never in controllers: capability checks, status-transition
 * guards, mark-paid due-check + billing-date advancement, and `subscription.*`
 * domain-event emission. Every repository call passes `ctx`.
 */

/**
 * Canonical status transitions.
 * `active ⇄ paused`, either `→ cancelled`; `cancelled` is terminal. Illegal
 * moves → INVALID_STATE_TRANSITION.
 */
export const SUBSCRIPTION_TRANSITIONS: Partial<Record<SubscriptionStatus, readonly SubscriptionStatus[]>> = {
  active: ["paused", "cancelled"],
  paused: ["active", "cancelled"],
  cancelled: [],
};

export const advanceBillingDate = (dateOnly: string, interval: SubscriptionInterval): string => {
  const parts = dateOnly.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (parts.length !== 3 || !Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    throw new AppError("VALIDATION_FAILED", `Invalid date: ${dateOnly}`);
  }
  switch (interval) {
    case "weekly":
      return addDays(y, m, d, 7);
    case "monthly":
      return addMonths(y, m, d, 1);
    case "quarterly":
      return addMonths(y, m, d, 3);
    case "yearly":
      return addMonths(y, m, d, 12);
  }
};

const pad = (n: number): string => {
  return String(n).padStart(2, "0");
};

const daysInMonth = (year: number, month1: number): number => {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
};

const addDays = (y: number, m: number, d: number, days: number): string => {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};

const addMonths = (y: number, m: number, d: number, months: number): string => {
  const total = (m - 1) + months;
  const year = y + Math.floor(total / 12);
  const month1 = (total % 12) + 1;
  const day = Math.min(d, daysInMonth(year, month1));
  return `${year}-${pad(month1)}-${pad(day)}`;
};

export const todayDateOnly = (now: Date = new Date()): string => {
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
};

export interface SubscriptionServiceDeps extends ServiceDeps<Subscription> {
  repo: SubscriptionRepository;
 /** Clock injection for testable due-date checks. */
  now?: () => Date;
}

export class SubscriptionService extends BaseService<Subscription> {
  private readonly subRepo: SubscriptionRepository;
  private readonly now: () => Date;

  constructor(deps: SubscriptionServiceDeps) {
    super(deps);
    this.subRepo = deps.repo;
    this.now = deps.now ?? (() => new Date());
  }

  async get(ctx: AuthContext, id: string): Promise<Subscription> {
    const doc = await this.subRepo.findById(ctx, id);
    if (!doc) throw new AppError("RESOURCE_NOT_FOUND", "Subscription not found");
    return doc;
  }

  async list(
    ctx: AuthContext,
    raw: Record<string, string | string[] | undefined>,
    whitelist: import("@billy/types").ListWhitelist,
  ): ReturnType<SubscriptionRepository["list"]> {
    return this.subRepo.list(ctx, raw, whitelist);
  }

  async create(ctx: AuthContext, input: SubscriptionCreateInput): Promise<Subscription> {
    const created = await this.subRepo.insert(ctx, {
      clientId: input.clientId ?? null,
      projectId: input.projectId ?? null,
      name: input.name,
      plan: input.plan,
      amountMinor: input.amountMinor,
      currency: input.currency,
      interval: input.interval,
      status: "active",
      startDate: input.startDate,
      nextBillingDate: input.nextBillingDate,
      lastPaidAt: null,
      url: input.url ?? null,
      note: input.note ?? null,
    });
    await this.emitEvent("subscription.created", ctx, created);
    return created;
  }

  async update(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    input: SubscriptionUpdateInput,
  ): Promise<Subscription> {
    const updated = await this.subRepo.updateVersioned(ctx, id, expectedVersion, input);
    await this.emitEvent("subscription.updated", ctx, updated);
    return updated;
  }

  async archive(ctx: AuthContext, id: string, expectedVersion: number): Promise<Subscription> {
    const updated = await this.subRepo.archive(ctx, id, expectedVersion);
    await this.emitEvent("subscription.archived", ctx, updated);
    return updated;
  }

  async restore(ctx: AuthContext, id: string, expectedVersion: number): Promise<Subscription> {
    const updated = await this.subRepo.restore(ctx, id, expectedVersion);
    await this.emitEvent("subscription.restored", ctx, updated);
    return updated;
  }

  async softDelete(ctx: AuthContext, id: string): Promise<void> {
    this.requireCapability(ctx, "canPermanentlyDelete");
 // Ensure it exists within scope before deleting (404 otherwise).
    const existing = await this.get(ctx, id);
    await this.subRepo.softDelete(ctx, id);
    await this.emitEvent("subscription.deleted", ctx, existing);
  }

 /** Status transition (pause / resume / cancel) via the canonical guard. */
  async changeStatus(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    next: SubscriptionStatus,
  ): Promise<Subscription> {
    const current = await this.get(ctx, id);
    assertTransition<SubscriptionStatus>(current.status, next, SUBSCRIPTION_TRANSITIONS);
    const updated = await this.subRepo.updateVersioned(ctx, id, expectedVersion, {
      status: next,
    } as Partial<Subscription>);
    await this.emitEvent(`subscription.status.${next}`, ctx, updated);
    return updated;
  }

  pause(ctx: AuthContext, id: string, expectedVersion: number): Promise<Subscription> {
    return this.changeStatus(ctx, id, expectedVersion, "paused");
  }

  resume(ctx: AuthContext, id: string, expectedVersion: number): Promise<Subscription> {
    return this.changeStatus(ctx, id, expectedVersion, "active");
  }

  cancel(ctx: AuthContext, id: string, expectedVersion: number): Promise<Subscription> {
    return this.changeStatus(ctx, id, expectedVersion, "cancelled");
  }

 /**
 * Record a payment. A payment is DUE when today has
 * reached `nextBillingDate`; otherwise → SUBSCRIPTION_PAYMENT_NOT_DUE (422).
 * On success: advance `nextBillingDate` by one interval and set `lastPaidAt`.
 */
  async markPaid(ctx: AuthContext, id: string, expectedVersion: number): Promise<Subscription> {
    const current = await this.get(ctx, id);
    const today = todayDateOnly(this.now());
    if (today < current.nextBillingDate) {
      throw new AppError("SUBSCRIPTION_PAYMENT_NOT_DUE", "Subscription payment is not yet due");
    }
    const advanced = advanceBillingDate(current.nextBillingDate, current.interval);
    const updated = await this.subRepo.updateVersioned(ctx, id, expectedVersion, {
      nextBillingDate: advanced,
      lastPaidAt: new Date().toISOString(),
    } as Partial<Subscription>);
    await this.emitEvent("subscription.payment.marked_paid", ctx, updated);
    return updated;
  }

  private async emitEvent(name: string, ctx: AuthContext, entity: Subscription): Promise<void> {
    await this.emit({
      name,
      actorId: ctx.userId,
      entityType: "subscription",
      entityId: entity.id,
      payload: { status: entity.status, nextBillingDate: entity.nextBillingDate },
    });
  }
}
