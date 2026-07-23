import type { AuthContext } from "@billy/types";
import { errors } from "@billy/shared";
import { BaseRepository, buildScopedFilter } from "@/platform/repository.js";
import type { Expense } from "@/modules/expenses/types.js";

/** Mongo collection name for expenses. */
export const EXPENSES_COLLECTION = "expenses";

const nowIso = (): string => new Date().toISOString();

/**
 * Expense data-access. Inherits the
 * mandatory-authContext, soft-delete/archive, and optimistic-concurrency
 * behaviour from BaseRepository. Adds `restore`, which cannot go through
 * `updateVersioned`: that path filters `archivedAt:null`, so an already-archived
 * document never matches. `restore` therefore queries with `archived:"all"`.
 */
export class ExpenseRepository extends BaseRepository<Expense> {
  /**
   * Restore an archived expense. Matches on {id, version} with
   * NO archive constraint (the doc is archived, which the default filter would
   * exclude); clears `archivedAt` and bumps `version`. Mismatch → VERSION_CONFLICT,
   * absent → RESOURCE_NOT_FOUND — mirroring `updateVersioned`.
   */
  async restore(ctx: AuthContext, id: string, expectedVersion: number): Promise<Expense> {
    const filter = buildScopedFilter<Expense>(
      ctx,
      { id, version: expectedVersion },
      { archived: "all" },
    );
    const result = await this.collection.findOneAndUpdate(
      filter,
      { $set: { archivedAt: null, updatedAt: nowIso() }, $inc: { version: 1 } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (!result) {
      const exists = await this.collection.findOne(
        buildScopedFilter<Expense>(ctx, { id }, { archived: "all" }),
        { projection: { id: 1 } },
      );
      throw exists ? errors.versionConflict() : errors.notFound();
    }
    return result as Expense;
  }
}
