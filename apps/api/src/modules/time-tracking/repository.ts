import type { Collection } from "mongodb";
import type { AuthContext } from "@billy/types";
import { errors } from "@billy/shared";
import { BaseRepository, assertAuthContext, buildScopedFilter } from "@/platform/repository.js";
import type { TimeEntry } from "@/modules/time-tracking/types.js";

export const TIME_ENTRIES_COLLECTION = "timeEntries";

/**
 * TimeEntry data access. Constructed WITHOUT a
 * scopeField: ownership is `userId` on the document (set at insert), not the
 * accountId stamp — the base scopeField would wrongly write the
 * single-tenant accountId value. Adds the per-user active-timer lookup the
 * base class does not provide, used to enforce one-running-timer-per-user.
 */
export class TimeEntryRepository extends BaseRepository<TimeEntry> {
  constructor(collection: Collection<TimeEntry>) {
    super(collection);
  }

  /** The user's current running or paused timer, if any. */
  async findActiveTimer(ctx: AuthContext, userId: string): Promise<TimeEntry | null> {
    assertAuthContext(ctx);
    const doc = await this.collection.findOne(
      { userId, timerState: { $in: ["running", "paused"] }, deletedAt: null } as never,
      { projection: { _id: 0 } },
    );
    return (doc as TimeEntry | null) ?? null;
  }

  /**
   * Find an entry regardless of archive state (base `findById` excludes archived).
   * Needed so archived entries can be restored / inspected.
   */
  async findByIdAnyArchive(ctx: AuthContext, id: string): Promise<TimeEntry | null> {
    assertAuthContext(ctx);
    const doc = await this.collection.findOne(
      buildScopedFilter<TimeEntry>(ctx, { id }, { archived: "all" }),
      { projection: { _id: 0 } },
    );
    return (doc as TimeEntry | null) ?? null;
  }

  /**
   * Restore an archived entry (clear `archivedAt`). The base `updateVersioned`
   * filters `archivedAt: null`, so an archived doc can never be matched by it;
   * this override queries with `archived: "all"`.
   */
  async restore(ctx: AuthContext, id: string, expectedVersion: number): Promise<TimeEntry> {
    assertAuthContext(ctx);
    const result = await this.collection.findOneAndUpdate(
      buildScopedFilter<TimeEntry>(ctx, { id, version: expectedVersion }, { archived: "all" }),
      { $set: { archivedAt: null, updatedAt: new Date().toISOString() }, $inc: { version: 1 } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (!result) {
      const exists = await this.collection.findOne(
        buildScopedFilter<TimeEntry>(ctx, { id }, { archived: "all" }),
        { projection: { id: 1 } },
      );
      throw exists ? errors.versionConflict() : errors.notFound();
    }
    return result as TimeEntry;
  }
}
