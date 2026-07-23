import type { AuthContext, BaseDoc } from "@billy/types";
import { AppError } from "@billy/shared";
import { BaseService, type ServiceDeps, assertTransition } from "@/platform/service.js";
import type { TimeEntry, TimerState } from "@/modules/time-tracking/types.js";
import {
  TIME_ENTRY_LIST_WHITELIST,
  type TimeEntryCreateInput,
  type TimeEntryUpdateInput,
  type TimerStartInput,
} from "@/modules/time-tracking/schema.js";
import type { TimeEntryRepository } from "@/modules/time-tracking/repository.js";

/**
 * TimeEntry business logic. All domain rules
 * live here: the timer state machine, one-running-timer-per-user,
 * duplicate-billing prevention, and `time.*` event emission. Money is
 * integer minor units. Every repo call passes the auth context.
 */

const ENTITY = "timeEntry";

/** Timer transitions. A resumable/stoppable machine over `timerState`. */
const TIMER_TRANSITIONS: Partial<Record<"running" | "paused" | "stopped", readonly ("running" | "paused" | "stopped")[]>> = {
  running: ["paused", "stopped"],
  paused: ["running", "stopped"],
};

const nowIso = (): string => {
  return new Date().toISOString();
};

const elapsedMinutes = (startedAt: string): number => {
  const ms = Date.now() - new Date(startedAt).getTime();
  return Math.max(0, Math.round(ms / 60000));
};

export interface TimeEntryServiceDeps extends ServiceDeps<TimeEntry> {
  repo: TimeEntryRepository;
}

export class TimeEntryService extends BaseService<TimeEntry> {
  protected override readonly repo: TimeEntryRepository;

  constructor(deps: TimeEntryServiceDeps) {
    super(deps);
    this.repo = deps.repo;
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  async list(ctx: AuthContext, raw: Record<string, string | string[] | undefined>) {
    return this.repo.list(ctx, raw, TIME_ENTRY_LIST_WHITELIST);
  }

  async getById(ctx: AuthContext, id: string): Promise<TimeEntry> {
    const doc = await this.repo.findById(ctx, id);
    if (!doc) throw new AppError("RESOURCE_NOT_FOUND", "Time entry not found");
    return doc;
  }

  async create(ctx: AuthContext, input: TimeEntryCreateInput): Promise<TimeEntry> {
    const data = this.buildInsert(ctx, {
      description: input.description,
      date: input.date,
      durationMinutes: input.durationMinutes,
      billable: input.billable,
      clientId: input.clientId,
      projectId: input.projectId,
      rateMinor: input.rateMinor,
      billed: false,
      invoiceId: null,
      timerState: null,
      timerStartedAt: null,
    });
    const created = await this.repo.insert(ctx, data);
    await this.emit({ name: "time.entry.created", actorId: ctx.userId, entityType: ENTITY, entityId: created.id });
    return created;
  }

  async update(ctx: AuthContext, id: string, version: number, patch: TimeEntryUpdateInput): Promise<TimeEntry> {
    await this.getById(ctx, id);
    const updated = await this.repo.updateVersioned(ctx, id, version, patch as Partial<TimeEntry>);
    await this.emit({ name: "time.entry.updated", actorId: ctx.userId, entityType: ENTITY, entityId: id });
    return updated;
  }

  async archive(ctx: AuthContext, id: string, version: number): Promise<TimeEntry> {
    await this.getById(ctx, id);
    const updated = await this.repo.updateVersioned(ctx, id, version, { archivedAt: nowIso() } as Partial<TimeEntry>);
    await this.emit({ name: "time.entry.archived", actorId: ctx.userId, entityType: ENTITY, entityId: id });
    return updated;
  }

  async restore(ctx: AuthContext, id: string, version: number): Promise<TimeEntry> {
    // Note: an archived entry is invisible to getById (base filter excludes it);
    // repo.restore matches with archived:"all", so no pre-read guard here.
    const updated = await this.repo.restore(ctx, id, version);
    await this.emit({ name: "time.entry.restored", actorId: ctx.userId, entityType: ENTITY, entityId: id });
    return updated;
  }

  /**
   * Soft-delete: DELETE requires `canPermanentlyDelete` for
   * members (administrators bypass). Uses findByIdAnyArchive so an archived
   * entry can still be deleted.
   */
  async softDelete(ctx: AuthContext, id: string): Promise<void> {
    this.requireCapability(ctx, "canPermanentlyDelete");
    const existing = await this.repo.findByIdAnyArchive(ctx, id);
    if (!existing) throw new AppError("RESOURCE_NOT_FOUND", "Time entry not found");
    await this.repo.softDelete(ctx, id);
    await this.emit({ name: "time.entry.deleted", actorId: ctx.userId, entityType: ENTITY, entityId: id });
  }

  // ── Timer ─────────────────────────────────────────────────────────

  /** Start a new running timer. Only one running/paused timer per user → TIMER_ALREADY_RUNNING. */
  async startTimer(ctx: AuthContext, input: TimerStartInput): Promise<TimeEntry> {
    const active = await this.repo.findActiveTimer(ctx, ctx.userId);
    if (active) throw new AppError("TIMER_ALREADY_RUNNING", "A timer is already running for this user");

    const data = this.buildInsert(ctx, {
      description: input.description ?? "",
      date: input.date ?? nowIso().slice(0, 10),
      durationMinutes: 0,
      billable: input.billable ?? true,
      clientId: input.clientId,
      projectId: input.projectId,
      rateMinor: input.rateMinor,
      billed: false,
      invoiceId: null,
      timerState: "running",
      timerStartedAt: nowIso(),
    });
    const created = await this.repo.insert(ctx, data);
    await this.emit({ name: "time.timer.started", actorId: ctx.userId, entityType: ENTITY, entityId: created.id });
    return created;
  }

  /** Pause a running timer: accumulate elapsed minutes, clear the running segment. */
  async pauseTimer(ctx: AuthContext, id: string): Promise<TimeEntry> {
    const entry = await this.getById(ctx, id);
    assertTransition(this.timerStage(entry.timerState), "paused", TIMER_TRANSITIONS);
    const gained = entry.timerStartedAt ? elapsedMinutes(entry.timerStartedAt) : 0;
    const updated = await this.repo.updateVersioned(ctx, id, entry.version, {
      timerState: "paused",
      timerStartedAt: null,
      durationMinutes: entry.durationMinutes + gained,
    } as Partial<TimeEntry>);
    await this.emit({ name: "time.timer.paused", actorId: ctx.userId, entityType: ENTITY, entityId: id });
    return updated;
  }

  /** Resume a paused timer: begin a new running segment. */
  async resumeTimer(ctx: AuthContext, id: string): Promise<TimeEntry> {
    const entry = await this.getById(ctx, id);
    assertTransition(this.timerStage(entry.timerState), "running", TIMER_TRANSITIONS);
    const updated = await this.repo.updateVersioned(ctx, id, entry.version, {
      timerState: "running",
      timerStartedAt: nowIso(),
    } as Partial<TimeEntry>);
    await this.emit({ name: "time.timer.resumed", actorId: ctx.userId, entityType: ENTITY, entityId: id });
    return updated;
  }

  /** Stop the timer: fold any running segment into durationMinutes and clear timer state. */
  async stopTimer(ctx: AuthContext, id: string): Promise<TimeEntry> {
    const entry = await this.getById(ctx, id);
    assertTransition(this.timerStage(entry.timerState), "stopped", TIMER_TRANSITIONS);
    const gained = entry.timerState === "running" && entry.timerStartedAt ? elapsedMinutes(entry.timerStartedAt) : 0;
    const updated = await this.repo.updateVersioned(ctx, id, entry.version, {
      timerState: null,
      timerStartedAt: null,
      durationMinutes: entry.durationMinutes + gained,
    } as Partial<TimeEntry>);
    await this.emit({ name: "time.timer.stopped", actorId: ctx.userId, entityType: ENTITY, entityId: id });
    return updated;
  }

  // ── Billing ────────────────────────────────────────────────────────

  /** Mark an entry billed against an invoice. Prevent double-billing → TIME_ENTRY_ALREADY_BILLED. */
  async markBilled(ctx: AuthContext, id: string, invoiceId: string): Promise<TimeEntry> {
    const entry = await this.getById(ctx, id);
    if (entry.billed) throw new AppError("TIME_ENTRY_ALREADY_BILLED", "Time entry is already billed");
    const updated = await this.repo.updateVersioned(ctx, id, entry.version, {
      billed: true,
      invoiceId,
    } as Partial<TimeEntry>);
    await this.emit({
      name: "time.entry.billed",
      actorId: ctx.userId,
      entityType: ENTITY,
      entityId: id,
      payload: { invoiceId },
    });
    return updated;
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** Map the nullable timerState onto the transition machine's terminal-less alphabet. */
  private timerStage(state: TimerState | undefined): "running" | "paused" | "stopped" {
    return state === "running" || state === "paused" ? state : "stopped";
  }

  /** Assemble the non-BaseDoc insert payload, stamping the owner from the auth context. */
  private buildInsert(ctx: AuthContext, fields: Omit<TimeEntry, keyof BaseDoc | "userId">): Omit<TimeEntry, keyof BaseDoc> {
    return { ...fields, userId: ctx.userId };
  }
}
