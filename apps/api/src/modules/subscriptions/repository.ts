import type { Collection } from "mongodb";
import type { AuthContext } from "@billy/types";
import { errors } from "@billy/shared";
import { BaseRepository, assertAuthContext, buildScopedFilter } from "@/platform/repository.js";
import type { Subscription } from "@/modules/subscriptions/types.js";

/**
 * Subscription data access. Inherits the mandatory
 * `authContext`, soft-delete, and optimistic-concurrency behaviour from
 * `BaseRepository`; adds archive/restore the base cannot express (base
 * `updateVersioned` forces `archivedAt:null`, so it only matches non-archived
 * docs — restore needs the inverse filter). Single-tenant "default" scope, so
 * no `scopeField`. No unscoped queries.
 */
export const SUBSCRIPTIONS_COLLECTION = "subscriptions";

const nowIso = (): string => new Date().toISOString();

export class SubscriptionRepository extends BaseRepository<Subscription> {
  constructor(collection: Collection<Subscription>) {
    super(collection);
  }

  /** Archive a live subscription → set `archivedAt`. Version-checked. */
  async archive(ctx: AuthContext, id: string, expectedVersion: number): Promise<Subscription> {
    assertAuthContext(ctx);
    const filter = buildScopedFilter<Subscription>(ctx, { id, version: expectedVersion });
    const result = await this.collection.findOneAndUpdate(
      filter,
      { $set: { archivedAt: nowIso(), updatedAt: nowIso() }, $inc: { version: 1 } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return this.resolveResult(ctx, id, result as Subscription | null);
  }

  /** Restore an archived subscription → clear `archivedAt`. Version-checked. */
  async restore(ctx: AuthContext, id: string, expectedVersion: number): Promise<Subscription> {
    assertAuthContext(ctx);
    // Must match ONLY archived docs — base updateVersioned forces archivedAt:null.
    const filter = buildScopedFilter<Subscription>(ctx, { id, version: expectedVersion }, { archived: "true" });
    const result = await this.collection.findOneAndUpdate(
      filter,
      { $set: { archivedAt: null, updatedAt: nowIso() }, $inc: { version: 1 } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return this.resolveResult(ctx, id, result as Subscription | null);
  }

  /** Disambiguate a null findOneAndUpdate: not-found (404) vs stale version (409). */
  private async resolveResult(ctx: AuthContext, id: string, result: Subscription | null): Promise<Subscription> {
    if (result) return result;
    const exists = await this.collection.findOne(
      buildScopedFilter<Subscription>(ctx, { id }, { archived: "all" }),
      { projection: { id: 1 } },
    );
    throw exists ? errors.versionConflict() : errors.notFound();
  }
}
