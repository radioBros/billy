import type { Collection } from "mongodb";
import type { AuthContext } from "@billy/types";
import { errors } from "@billy/shared";
import { BaseRepository, assertAuthContext, buildScopedFilter } from "@/platform/repository.js";
import type { Contract } from "@/modules/contracts/types.js";

/** Mongo collection name for contracts. */
export const CONTRACTS_COLLECTION = "contracts";

const nowIso = (): string => new Date().toISOString();

/**
 * Contract data access. Inherits the mandatory-`authContext`, soft-delete,
 * and optimistic-concurrency behaviour from `BaseRepository`; adds archive/restore
 * the base cannot express (base `updateVersioned` forces `archivedAt:null`, so it
 * can only match non-archived docs — restore needs the inverse filter). Contract
 * has NO business-scope field (single-tenant "default"), so no `scopeField`.
 */
export class ContractRepository extends BaseRepository<Contract> {
  constructor(collection: Collection<Contract>) {
    super(collection);
  }

  /** Archive a live contract → set `archivedAt`. Version-checked. */
  async archive(ctx: AuthContext, id: string, expectedVersion: number): Promise<Contract> {
    assertAuthContext(ctx);
    const filter = buildScopedFilter<Contract>(ctx, { id, version: expectedVersion });
    const result = await this.collection.findOneAndUpdate(
      filter,
      { $set: { archivedAt: nowIso(), updatedAt: nowIso() }, $inc: { version: 1 } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return this.resolveResult(ctx, id, result as Contract | null);
  }

  /** Restore an archived contract → clear `archivedAt`. Version-checked. */
  async restore(ctx: AuthContext, id: string, expectedVersion: number): Promise<Contract> {
    assertAuthContext(ctx);
    // Must match ONLY archived docs — base updateVersioned forces archivedAt:null.
    const filter = buildScopedFilter<Contract>(ctx, { id, version: expectedVersion }, { archived: "true" });
    const result = await this.collection.findOneAndUpdate(
      filter,
      { $set: { archivedAt: null, updatedAt: nowIso() }, $inc: { version: 1 } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return this.resolveResult(ctx, id, result as Contract | null);
  }

  /** Disambiguate a null findOneAndUpdate: not-found (404) vs stale version (409). */
  private async resolveResult(ctx: AuthContext, id: string, result: Contract | null): Promise<Contract> {
    if (result) return result;
    const exists = await this.collection.findOne(
      buildScopedFilter<Contract>(ctx, { id }, { archived: "all" }),
      { projection: { id: 1 } },
    );
    throw exists ? errors.versionConflict() : errors.notFound();
  }
}
