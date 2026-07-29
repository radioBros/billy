import type { Collection } from "mongodb";
import type { AuthContext } from "@billy/types";
import { errors } from "@billy/shared";
import { BaseRepository, assertAuthContext, buildScopedFilter } from "@/platform/repository.js";
import type { Invoice } from "@/modules/invoices/types.js";

/** Mongo collection name for invoices. */
export const INVOICES_COLLECTION = "invoices";

const nowIso = (): string => new Date().toISOString();

/**
 * Data access for the Invoice entity. Inherits the mandatory-
 * `authContext`, soft-delete, archive, and optimistic-concurrency behaviour from
 * `BaseRepository`; adds archive/restore (the base `updateVersioned` forces
 * `archivedAt:null`, so it cannot match archived docs) and `replaceState` — a
 * versioned full-field update used by finalize/void/payment mutations that must
 * write `status`, totals, or the payments array (all outside the create/update
 * editor path).
 */
export class InvoiceRepository extends BaseRepository<Invoice> {
  constructor(collection: Collection<Invoice>) {
    super(collection);
  }

  /**
   * Versioned patch of server-owned fields (status/totals/payments/number/snapshot)
   * used by finalize/void/addPayment/removePayment. Distinct from `updateVersioned`
   * only in intent — it exists so the service never routes lifecycle writes through
   * the editor path. Matches non-archived docs (finalize/pay/void act on live docs).
   */
  async replaceState(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    patch: Partial<Invoice>,
  ): Promise<Invoice> {
    return this.updateVersioned(ctx, id, expectedVersion, patch);
  }

  /** Archive a live invoice → set `archivedAt`. Version-checked. */
  async archive(ctx: AuthContext, id: string, expectedVersion: number): Promise<Invoice> {
    assertAuthContext(ctx);
    const filter = buildScopedFilter<Invoice>(ctx, { id, version: expectedVersion });
    const result = await this.collection.findOneAndUpdate(
      filter,
      { $set: { archivedAt: nowIso(), updatedAt: nowIso() }, $inc: { version: 1 } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return this.resolveResult(ctx, id, result as Invoice | null);
  }

  /** Restore an archived invoice → clear `archivedAt`. Version-checked. */
  async restore(ctx: AuthContext, id: string, expectedVersion: number): Promise<Invoice> {
    assertAuthContext(ctx);
    const filter = buildScopedFilter<Invoice>(ctx, { id, version: expectedVersion }, { archived: "true" });
    const result = await this.collection.findOneAndUpdate(
      filter,
      { $set: { archivedAt: null, updatedAt: nowIso() }, $inc: { version: 1 } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return this.resolveResult(ctx, id, result as Invoice | null);
  }

  /** Disambiguate a null findOneAndUpdate: not-found (404) vs stale version (409). */
  private async resolveResult(ctx: AuthContext, id: string, result: Invoice | null): Promise<Invoice> {
    if (result) return result;
    const exists = await this.collection.findOne(
      buildScopedFilter<Invoice>(ctx, { id }, { archived: "all" }),
      { projection: { id: 1 } },
    );
    throw exists ? errors.versionConflict() : errors.notFound();
  }
}
