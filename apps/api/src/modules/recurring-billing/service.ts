import type { Db } from "mongodb";
import type { AuthContext, ListMeta } from "@billy/types";
import { AppError, errors, advanceRecurrence, firstRunOnOrAfter } from "@billy/shared";
import type { MinioConn } from "@/infrastructure/minio.js";
import { FILES_BUCKET } from "@/modules/files-storage/service.js";
import { BaseService, assertTransition, type ServiceDeps } from "@/platform/service.js";
import { computeDocumentTotals, type LineItemInput } from "@/platform/money.js";
import type { RecurringProfileRepository } from "@/modules/recurring-billing/repository.js";
import {
  RECURRING_PROFILE_LIST_WHITELIST,
  type RecurringProfileCreateInput,
  type RecurringProfileUpdateInput,
} from "@/modules/recurring-billing/schema.js";
import type {
  InvoiceDraftPayload,
  RecurringInterval,
  RecurringProfile,
  RecurringProfileStatus,
} from "@/modules/recurring-billing/types.js";

/**
 * Advance a recurring profile's date by one step. Thin wrapper over the shared
 * `advanceRecurrence` (the SINGLE source of truth, shared with the worker) that
 * keeps this module's validation error type. `dayOfMonth` anchors monthly-family
 * advances to a fixed day (drift-free); ignored for weekly.
 */
export const advanceDate = (
  dateOnly: string,
  interval: RecurringInterval,
  intervalCount: number,
  dayOfMonth?: number | null,
): string => {
  const parts = dateOnly.split("-");
  if (parts.length !== 3 || parts.some((p) => !Number.isInteger(Number(p)))) {
    throw new AppError("VALIDATION_FAILED", `Invalid date: ${dateOnly}`);
  }
  return advanceRecurrence(dateOnly, interval, intervalCount, dayOfMonth);
};

// ── Service ───────────────────────────────────────────────────────────────────

export interface RecurringProfileServiceDeps extends ServiceDeps<RecurringProfile> {
  repo: RecurringProfileRepository;
  /** For the delete-time attachment cascade (auto-send extra files). Optional so
   *  tests may omit it; when absent, deletion proceeds without file cleanup. */
  db?: Db;
  minio?: MinioConn;
  /**
   * Enqueue a one-off recurring tick (the worker's scan handler). Called when a
   * profile is created already-due (startDate today or past) so the first
   * occurrence is generated — and auto-sent — immediately instead of waiting
   * for the next 15-minute repeatable tick. Optional (tests / queue-less boots).
   */
  enqueueTick?: (profile: { id: string; nextRunAt: string; accountId: string }) => Promise<void>;
}

/**
 * Explicit-action transitions (no `draft`; created `active`).
 * completed/cancelled are terminal.
 */
const ALLOWED_TRANSITIONS: Partial<Record<RecurringProfileStatus, readonly RecurringProfileStatus[]>> = {
  active: ["paused", "completed", "cancelled"],
  paused: ["active", "cancelled"],
};

export class RecurringProfileService extends BaseService<RecurringProfile> {
  protected override readonly repo: RecurringProfileRepository;
  readonly #db?: Db;
  readonly #minio?: MinioConn;
  readonly #enqueueTick?: RecurringProfileServiceDeps["enqueueTick"];

  constructor(deps: RecurringProfileServiceDeps) {
    super(deps);
    this.repo = deps.repo;
    this.#db = deps.db;
    this.#minio = deps.minio;
    this.#enqueueTick = deps.enqueueTick;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  async get(ctx: AuthContext, id: string): Promise<RecurringProfile> {
    const doc = await this.repo.findById(ctx, id);
    if (!doc) throw errors.notFound();
    return doc;
  }

  async list(
    ctx: AuthContext,
    rawQuery: Record<string, string | string[] | undefined>,
  ): Promise<{ items: RecurringProfile[]; meta: ListMeta }> {
    const { items, parsed, total } = await this.repo.list(ctx, rawQuery, RECURRING_PROFILE_LIST_WHITELIST);
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

  // ── Create / update ──────────────────────────────────────────────────────────

  /** Create an `active` profile; `nextRunAt` starts at `startDate`. */
  async create(ctx: AuthContext, input: RecurringProfileCreateInput): Promise<RecurringProfile> {
    const totals = computeDocumentTotals(input.lineItems as LineItemInput[]);
    // With a monthly-family day-of-month anchor, the first run lands on the anchor
    // day on/after startDate (e.g. start 2026-03-05, anchor 15 → first run 03-15).
    const anchor = input.dayOfMonth ?? null;
    const firstRun =
      anchor != null && input.interval !== "weekly"
        ? firstRunOnOrAfter(input.startDate, anchor)
        : input.startDate;
    const created = await this.repo.insert(ctx, {
      clientId: input.clientId,
      documentType: input.documentType,
      lineItems: totals.lines,
      currency: input.currency,
      interval: input.interval,
      intervalCount: input.intervalCount,
      dayOfMonth: anchor,
      startDate: input.startDate,
      nextRunAt: firstRun,
      endDate: input.endDate ?? null,
      maxOccurrences: input.maxOccurrences ?? null,
      occurrencesGenerated: 0,
      status: "active",
      lastRunAt: null,
      createdInvoiceIds: [],
      subtotalMinor: totals.subtotalMinor,
      discountMinor: totals.discountMinor,
      taxMinor: totals.taxMinor,
      grandTotalMinor: totals.grandTotalMinor,
      subject: input.subject ?? null,
      notes: input.notes ?? null,
      autoSend: input.autoSend ?? null,
    });
    await this.emit(this.event("recurring.profile_created", ctx, created.id, { status: "active" }));

    // First occurrence already due (start today / in the past) → kick the worker
    // tick NOW so the document is generated (and auto-sent, when configured)
    // immediately rather than on the next 15-minute repeatable tick. Best-effort:
    // a queue blip must not fail the create — the repeatable tick catches up.
    if (created.nextRunAt <= new Date().toISOString().slice(0, 10)) {
      try {
        await this.#enqueueTick?.({ id: created.id, nextRunAt: created.nextRunAt, accountId: ctx.accountId });
      } catch (err) {
        this.logger.warn({ err, profileId: created.id }, "recurring: immediate tick enqueue failed (repeatable tick will catch up)");
      }
    }
    return created;
  }

  /**
   * Edit a profile. Totals recomputed; client totals
   * ignored. Editing is allowed for active/paused profiles; cancelled/completed
   * are terminal (RECURRING_PROFILE_INACTIVE). Editing the template never mutates
   * already-generated invoices (invoices are snapshot copies).
   */
  async update(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    input: RecurringProfileUpdateInput,
  ): Promise<RecurringProfile> {
    const existing = await this.get(ctx, id);
    if (existing.status === "completed" || existing.status === "cancelled") {
      throw new AppError("RECURRING_PROFILE_INACTIVE", `Cannot edit a ${existing.status} profile`);
    }
    const { version: _ignored, ...patch } = input;
    void _ignored;

    const effectiveLines = (input.lineItems ?? existing.lineItems) as LineItemInput[];
    const totals = computeDocumentTotals(effectiveLines);

    const updated = await this.repo.updateVersioned(ctx, id, expectedVersion, {
      ...patch,
      endDate: patch.endDate ?? existing.endDate ?? null,
      maxOccurrences: patch.maxOccurrences ?? existing.maxOccurrences ?? null,
      lineItems: totals.lines,
      subtotalMinor: totals.subtotalMinor,
      discountMinor: totals.discountMinor,
      taxMinor: totals.taxMinor,
      grandTotalMinor: totals.grandTotalMinor,
    } as Partial<RecurringProfile>);
    await this.emit(this.event("recurring.profile_updated", ctx, updated.id));
    return updated;
  }

  // ── Status transitions ────────────────────────────

  async pause(ctx: AuthContext, id: string, expectedVersion: number): Promise<RecurringProfile> {
    return this.transition(ctx, id, expectedVersion, "paused", "recurring.profile_paused");
  }

  async resume(ctx: AuthContext, id: string, expectedVersion: number): Promise<RecurringProfile> {
    return this.transition(ctx, id, expectedVersion, "active", "recurring.profile_resumed");
  }

  async cancel(ctx: AuthContext, id: string, expectedVersion: number): Promise<RecurringProfile> {
    return this.transition(ctx, id, expectedVersion, "cancelled", "recurring.profile_cancelled");
  }

  private async transition(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    next: RecurringProfileStatus,
    eventName: string,
  ): Promise<RecurringProfile> {
    const existing = await this.get(ctx, id);
    assertTransition<RecurringProfileStatus>(existing.status, next, ALLOWED_TRANSITIONS);
    const saved = await this.repo.replaceState(ctx, id, expectedVersion, { status: next });
    await this.emit(this.event(eventName, ctx, saved.id, { status: next }));
    return saved;
  }

  // ── Occurrence generation ────────────────

  /**
   * Idempotently produce the invoice-draft payload for the profile's *current*
   * occurrence (scheduledDate = `nextRunAt`) and advance the schedule. Returns
   * `null` when the profile completes without generating (already exhausted).
   * Does NOT create an invoice — the jobs layer does that via the invoices service.
   *
   * Order:
   *   load → guard active → idempotency → pre-exhaustion → build payload →
   *   advance/increment/set lastRunAt → post-check completion → persist.
   *
   * Idempotency (key = profileId+scheduledDate):
   * generation is forward-only, so a scheduledDate already covered by
   * a prior run satisfies `scheduledDate <= lastRunAt` → OCCURRENCE_ALREADY_GENERATED.
   * A duplicate enqueue (crash/replay/run-now) that resets nextRunAt to a past date
   * therefore cannot produce a second invoice for that occurrence.
   */
  async generateOccurrence(ctx: AuthContext, profileId: string): Promise<InvoiceDraftPayload | null> {
    const profile = await this.get(ctx, profileId);

    // 1. Only active profiles generate.
    if (profile.status !== "active") {
      throw new AppError("RECURRING_PROFILE_INACTIVE", `Profile is ${profile.status}, not active`);
    }

    const scheduledDate = profile.nextRunAt;

    // 2. Idempotency: this occurrence date has already been generated.
    if (profile.lastRunAt != null && scheduledDate <= profile.lastRunAt) {
      throw new AppError(
        "OCCURRENCE_ALREADY_GENERATED",
        `Occurrence ${scheduledDate} for profile ${profileId} already generated`,
      );
    }

    // 3. Pre-generation exhaustion → complete without generating (return null).
    //    (status is necessarily "active" here per the guard above.)
    if (this.isExhausted(profile, scheduledDate)) {
      const done = await this.repo.replaceState(ctx, profileId, profile.version, { status: "completed" });
      await this.emit(this.event("recurring.profile_completed", ctx, done.id, { reason: "exhausted" }));
      return null;
    }

    // 4. Build the payload — RAW line inputs (invoices recomputes money).
    const payload: InvoiceDraftPayload = {
      clientId: profile.clientId,
      currency: profile.currency,
      lineItems: profile.lineItems.map(toLineItemInput),
      sourceRecurringProfileId: profileId,
      issueDate: scheduledDate,
    };

    // 5. Advance the schedule.
    const occurrencesGenerated = profile.occurrencesGenerated + 1;
    const nextRunAt = advanceDate(scheduledDate, profile.interval, profile.intervalCount, profile.dayOfMonth);

    // 6. Post-check: did THIS run exhaust the schedule (boundary generation)?
    const completedNow = this.isExhausted(
      { ...profile, occurrencesGenerated },
      nextRunAt,
    );

    await this.repo.replaceState(ctx, profileId, profile.version, {
      nextRunAt,
      lastRunAt: scheduledDate,
      occurrencesGenerated,
      status: completedNow ? "completed" : profile.status,
    });

    await this.emit(
      this.event("recurring.occurrence_generated", ctx, profileId, {
        scheduledDate,
        occurrencesGenerated,
      }),
    );
    if (completedNow) {
      await this.emit(this.event("recurring.profile_completed", ctx, profileId, { reason: "exhausted" }));
    }
    return payload;
  }

  /**
   * A profile is exhausted for a prospective occurrence at `date` when the max
   * count is reached OR the date falls past `endDate`
   * (respects maxOccurrences/endDate).
   */
  private isExhausted(
    profile: Pick<RecurringProfile, "maxOccurrences" | "occurrencesGenerated" | "endDate">,
    date: string,
  ): boolean {
    if (profile.maxOccurrences != null && profile.occurrencesGenerated >= profile.maxOccurrences) return true;
    if (profile.endDate != null && date > profile.endDate) return true;
    return false;
  }

  // ── Archive / restore / delete ─────────────────────────────────────────────────

  async archive(ctx: AuthContext, id: string, expectedVersion: number): Promise<RecurringProfile> {
    const archived = await this.repo.archive(ctx, id, expectedVersion);
    await this.emit(this.event("recurring.profile_updated", ctx, archived.id, { archived: true }));
    return archived;
  }

  async restore(ctx: AuthContext, id: string, expectedVersion: number): Promise<RecurringProfile> {
    const restored = await this.repo.restore(ctx, id, expectedVersion);
    await this.emit(this.event("recurring.profile_updated", ctx, restored.id, { restored: true }));
    return restored;
  }

  /** Soft-delete (DELETE /:id → `deletedAt`), gated by `canPermanentlyDelete`.
   *  Cascades to the profile's auto-send attachment files (the user's requirement:
   *  "the files need to be deleted with it"): each owned file's MinIO object is
   *  removed and its metadata soft-deleted. NOTE: the profile itself is only
   *  soft-deleted (a `/restore` route exists), so a restored profile whose auto-send
   *  referenced these files would lose those attachments — acceptable per the
   *  explicit delete-the-files intent, and each occurrence re-validates attachments
   *  at send time (a missing extra is dropped, the invoice PDF still sends). */
  async softDelete(ctx: AuthContext, id: string): Promise<void> {
    this.requireCapability(ctx, "canPermanentlyDelete");
    const existing = await this.repo.findById(ctx, id);
    if (!existing) throw errors.notFound();
    await this.repo.softDelete(ctx, id);
    // Best-effort file cleanup — never let a storage hiccup block the profile delete.
    await this.deleteAttachmentFiles(ctx, id);
    await this.emit(this.event("recurring.profile_updated", ctx, id, { deleted: true }));
  }

  /**
   * Remove every auto-send attachment file owned by this profile
   * (ownerType "recurring-profile", ownerId = profile id): delete the MinIO object
   * and soft-delete the file metadata. Self-contained (reads the `files` collection
   * + minio directly) to avoid coupling the FilesService in. Fully best-effort:
   * any error is logged and swallowed so profile deletion always succeeds.
   */
  private async deleteAttachmentFiles(ctx: AuthContext, profileId: string): Promise<void> {
    if (!this.#db || !this.#minio) return;
    try {
      const files = this.#db.collection<{ id: string; objectKey: string }>("files");
      const owned = await files
        .find({ ownerType: "recurring-profile", ownerId: profileId, accountId: ctx.accountId, deletedAt: null } as never, {
          projection: { _id: 0, id: 1, objectKey: 1 },
        })
        .toArray();
      for (const f of owned) {
        try {
          await this.#minio.client.removeObject(FILES_BUCKET, f.objectKey);
        } catch (err) {
          this.logger.error({ err, objectKey: f.objectKey, profileId }, "auto-send attachment: minio removeObject failed (metadata still soft-deleted)");
        }
      }
      if (owned.length > 0) {
        await files.updateMany(
          { ownerType: "recurring-profile", ownerId: profileId, accountId: ctx.accountId, deletedAt: null } as never,
          { $set: { deletedAt: new Date().toISOString() } } as never,
        );
      }
    } catch (err) {
      this.logger.error({ err, profileId }, "auto-send attachment cleanup failed (profile still deleted)");
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private event(name: string, ctx: AuthContext, entityId: string, payload?: Record<string, unknown>) {
    return {
      name,
      actorId: ctx.userId,
      entityType: "recurring_profile",
      entityId,
      ...(payload ? { payload } : {}),
    };
  }
}

const toLineItemInput = (line: RecurringProfile["lineItems"][number]): LineItemInput => {
  return {
    description: line.description,
    quantity: line.quantity,
    unitPriceMinor: line.unitPriceMinor,
    ...(line.discountRate != null ? { discountRate: line.discountRate } : {}),
    ...(line.taxRate != null ? { taxRate: line.taxRate } : {}),
  };
};
