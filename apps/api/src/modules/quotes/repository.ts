import type { Collection } from "mongodb";
import type { AuthContext } from "@billy/types";
import { errors } from "@billy/shared";
import { BaseRepository, assertAuthContext, buildScopedFilter } from "@/platform/repository.js";
import type { Quote } from "@/modules/quotes/types.js";

/** Mongo collection name for quotes. */
export const QUOTES_COLLECTION = "quotes";

const nowIso = (): string => new Date().toISOString();

/**
 * Data access for the Quote entity. Inherits the mandatory-
 * `authContext`, soft-delete, archive, and optimistic-concurrency behaviour from
 * `BaseRepository`; adds archive/restore (the base `updateVersioned` forces
 * `archivedAt:null`, so it cannot match an archived doc — restore needs the
 * inverse filter), mirroring the clients module.
 */
export class QuoteRepository extends BaseRepository<Quote> {
  constructor(collection: Collection<Quote>) {
    super(collection);
  }

  /** Archive a live quote → set `archivedAt`. Version-checked. */
  async archive(ctx: AuthContext, id: string, expectedVersion: number): Promise<Quote> {
    assertAuthContext(ctx);
    const filter = buildScopedFilter<Quote>(ctx, { id, version: expectedVersion });
    const result = await this.collection.findOneAndUpdate(
      filter,
      { $set: { archivedAt: nowIso(), updatedAt: nowIso() }, $inc: { version: 1 } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return this.resolveResult(ctx, id, result as Quote | null);
  }

  /** Restore an archived quote → clear `archivedAt`. Version-checked. */
  async restore(ctx: AuthContext, id: string, expectedVersion: number): Promise<Quote> {
    assertAuthContext(ctx);
    const filter = buildScopedFilter<Quote>(ctx, { id, version: expectedVersion }, { archived: "true" });
    const result = await this.collection.findOneAndUpdate(
      filter,
      { $set: { archivedAt: null, updatedAt: nowIso() }, $inc: { version: 1 } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return this.resolveResult(ctx, id, result as Quote | null);
  }

  /** Disambiguate a null findOneAndUpdate: not-found (404) vs stale version (409). */
  private async resolveResult(ctx: AuthContext, id: string, result: Quote | null): Promise<Quote> {
    if (result) return result;
    const exists = await this.collection.findOne(buildScopedFilter<Quote>(ctx, { id }, { archived: "all" }), {
      projection: { id: 1 },
    });
    throw exists ? errors.versionConflict() : errors.notFound();
  }
}
