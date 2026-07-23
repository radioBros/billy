import type { Collection } from "mongodb";
import type { AuthContext } from "@billy/types";
import { errors } from "@billy/shared";
import { BaseRepository, assertAuthContext, buildScopedFilter } from "@/platform/repository.js";
import type { Client } from "@/modules/clients/types.js";

/** Mongo collection name for clients. */
export const CLIENTS_COLLECTION = "clients";

const nowIso = (): string => new Date().toISOString();

/**
 * Data access for the Client entity. Inherits the mandatory-
 * `authContext`, soft-delete, archive, and optimistic-concurrency behaviour from
 * `BaseRepository`; adds the archive/restore operations the base class cannot
 * express (the base `updateVersioned` forces `archivedAt:null`, so it can only
 * match non-archived docs — restore needs the inverse filter).
 */
export class ClientRepository extends BaseRepository<Client> {
  constructor(collection: Collection<Client>) {
    super(collection);
  }

  /** Archive a live client → set `archivedAt`. Version-checked. */
  async archive(ctx: AuthContext, id: string, expectedVersion: number): Promise<Client> {
    assertAuthContext(ctx);
    // A live (non-archived) doc — default archive filter matches it.
    const filter = buildScopedFilter<Client>(ctx, { id, version: expectedVersion });
    const result = await this.collection.findOneAndUpdate(
      filter,
      { $set: { archivedAt: nowIso(), updatedAt: nowIso() }, $inc: { version: 1 } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return this.resolveResult(ctx, id, result as Client | null);
  }

  /** Restore an archived client → clear `archivedAt`. Version-checked. */
  async restore(ctx: AuthContext, id: string, expectedVersion: number): Promise<Client> {
    assertAuthContext(ctx);
    // Must match ONLY archived docs — the base updateVersioned cannot, it forces archivedAt:null.
    const filter = buildScopedFilter<Client>(ctx, { id, version: expectedVersion }, { archived: "true" });
    const result = await this.collection.findOneAndUpdate(
      filter,
      { $set: { archivedAt: null, updatedAt: nowIso() }, $inc: { version: 1 } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return this.resolveResult(ctx, id, result as Client | null);
  }

  /** Disambiguate a null findOneAndUpdate: not-found (404) vs stale version (409). */
  private async resolveResult(ctx: AuthContext, id: string, result: Client | null): Promise<Client> {
    if (result) return result;
    const exists = await this.collection.findOne(
      buildScopedFilter<Client>(ctx, { id }, { archived: "all" }),
      { projection: { id: 1 } },
    );
    throw exists ? errors.versionConflict() : errors.notFound();
  }
}
