import type { Collection } from "mongodb";
import type { AuthContext } from "@billy/types";
import { errors } from "@billy/shared";
import { BaseRepository, assertAuthContext, buildScopedFilter } from "@/platform/repository.js";
import type { RecurringProfile } from "@/modules/recurring-billing/types.js";

/** Mongo collection name for recurring profiles. */
export const RECURRING_PROFILES_COLLECTION = "recurringProfiles";

const nowIso = (): string => new Date().toISOString();

/**
 * Data access for the RecurringProfile entity.
 * Inherits mandatory-`authContext`, soft-delete, archive, and optimistic-
 * concurrency behaviour from `BaseRepository`; adds archive/restore (the base
 * `updateVersioned` forces `archivedAt:null`, so it cannot match archived docs)
 * and `replaceState` — a versioned full-field update used by the lifecycle
 * writes (status transitions, `generateOccurrence` advancing nextRunAt /
 * occurrencesGenerated / lastRunAt) that must never route through the editor path.
 */
export class RecurringProfileRepository extends BaseRepository<RecurringProfile> {
  constructor(collection: Collection<RecurringProfile>) {
    super(collection);
  }

  /**
   * Versioned patch of server-owned fields (status/nextRunAt/occurrencesGenerated/
   * lastRunAt/createdInvoiceIds). Distinct from `updateVersioned` only in intent —
   * it exists so the service never routes lifecycle writes through the editor path.
   * Matches non-archived docs (transitions/generation act on live profiles).
   */
  async replaceState(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    patch: Partial<RecurringProfile>,
  ): Promise<RecurringProfile> {
    return this.updateVersioned(ctx, id, expectedVersion, patch);
  }

  /** Archive a live profile → set `archivedAt`. Version-checked. */
  async archive(ctx: AuthContext, id: string, expectedVersion: number): Promise<RecurringProfile> {
    assertAuthContext(ctx);
    const filter = buildScopedFilter<RecurringProfile>(ctx, { id, version: expectedVersion });
    const result = await this.collection.findOneAndUpdate(
      filter,
      { $set: { archivedAt: nowIso(), updatedAt: nowIso() }, $inc: { version: 1 } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return this.resolveResult(ctx, id, result as RecurringProfile | null);
  }

  /** Restore an archived profile → clear `archivedAt`. Version-checked. */
  async restore(ctx: AuthContext, id: string, expectedVersion: number): Promise<RecurringProfile> {
    assertAuthContext(ctx);
    const filter = buildScopedFilter<RecurringProfile>(ctx, { id, version: expectedVersion }, { archived: "true" });
    const result = await this.collection.findOneAndUpdate(
      filter,
      { $set: { archivedAt: null, updatedAt: nowIso() }, $inc: { version: 1 } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return this.resolveResult(ctx, id, result as RecurringProfile | null);
  }

  /** Disambiguate a null findOneAndUpdate: not-found (404) vs stale version (409). */
  private async resolveResult(
    ctx: AuthContext,
    id: string,
    result: RecurringProfile | null,
  ): Promise<RecurringProfile> {
    if (result) return result;
    const exists = await this.collection.findOne(
      buildScopedFilter<RecurringProfile>(ctx, { id }, { archived: "all" }),
      { projection: { id: 1 } },
    );
    throw exists ? errors.versionConflict() : errors.notFound();
  }
}
