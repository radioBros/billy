import type { Collection } from "mongodb";
import type { AuthContext } from "@billy/types";
import { errors } from "@billy/shared";
import { BaseRepository, assertAuthContext, buildScopedFilter } from "@/platform/repository.js";
import type { CreditNote } from "@/modules/credit-notes/types.js";

/** Mongo collection name for credit notes. */
export const CREDIT_NOTES_COLLECTION = "creditNotes";

const nowIso = (): string => new Date().toISOString();

/**
 * Data access for the CreditNote entity. Inherits mandatory-`authContext`,
 * soft-delete, archive, and optimistic-concurrency behaviour from `BaseRepository`;
 * adds archive/restore (the base `updateVersioned` forces `archivedAt:null`, so it
 * cannot match archived docs) and `replaceState` — a versioned full-field update
 * used by issue/void that must write `status`, the number, or the snapshot.
 * Mirrors the invoices repository exactly.
 */
export class CreditNoteRepository extends BaseRepository<CreditNote> {
  constructor(collection: Collection<CreditNote>) {
    super(collection);
  }

  /**
   * Versioned patch of server-owned fields (status/number/snapshot) used by
   * issue/void. Distinct from `updateVersioned` only in intent — it exists so the
   * service never routes lifecycle writes through the editor path. Matches
   * non-archived docs (issue/void act on live docs).
   */
  async replaceState(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    patch: Partial<CreditNote>,
  ): Promise<CreditNote> {
    return this.updateVersioned(ctx, id, expectedVersion, patch);
  }

  /** Archive a live credit note → set `archivedAt`. Version-checked. */
  async archive(ctx: AuthContext, id: string, expectedVersion: number): Promise<CreditNote> {
    assertAuthContext(ctx);
    const filter = buildScopedFilter<CreditNote>(ctx, { id, version: expectedVersion });
    const result = await this.collection.findOneAndUpdate(
      filter,
      { $set: { archivedAt: nowIso(), updatedAt: nowIso() }, $inc: { version: 1 } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return this.resolveResult(ctx, id, result as CreditNote | null);
  }

  /** Restore an archived credit note → clear `archivedAt`. Version-checked. */
  async restore(ctx: AuthContext, id: string, expectedVersion: number): Promise<CreditNote> {
    assertAuthContext(ctx);
    const filter = buildScopedFilter<CreditNote>(ctx, { id, version: expectedVersion }, { archived: "true" });
    const result = await this.collection.findOneAndUpdate(
      filter,
      { $set: { archivedAt: null, updatedAt: nowIso() }, $inc: { version: 1 } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return this.resolveResult(ctx, id, result as CreditNote | null);
  }

  /** Disambiguate a null findOneAndUpdate: not-found (404) vs stale version (409). */
  private async resolveResult(ctx: AuthContext, id: string, result: CreditNote | null): Promise<CreditNote> {
    if (result) return result;
    const exists = await this.collection.findOne(
      buildScopedFilter<CreditNote>(ctx, { id }, { archived: "all" }),
      { projection: { id: 1 } },
    );
    throw exists ? errors.versionConflict() : errors.notFound();
  }
}
