import { type Collection, type Filter, ObjectId } from "mongodb";
import { type AuthContext, type BaseDoc, type ListWhitelist } from "@billy/types";
import { AppError, errors } from "@billy/shared";
import { parseListQuery, type ParsedListQuery } from "@/platform/list-query.js";

/**
 * Base data-access layer. Two guarantees:
 *   1. Every method takes a mandatory `authContext` (type-enforced + runtime-guarded).
 *   2. Tenancy is FAIL-CLOSED: `BaseRepository` scopes + stamps `accountId` on
 *      EVERY query and insert. A repository cannot accidentally serve or write
 *      cross-account data. The only way to opt out is to extend `GlobalRepository`
 *      explicitly (accounts, users, sessions) — which reads as a deliberate,
 *      reviewable choice, not a silent default.
 *
 * Also applies soft-delete (`deletedAt:null`) + archive defaults and
 * optimistic-concurrency `version` handling.
 */

/** The document field that carries the tenant boundary. */
export const ACCOUNT_SCOPE_FIELD = "accountId" as const;

/**
 * Runtime guard — an account-scoped query must never run without a real user AND
 * a real accountId. This is the last line of defense behind the type system.
 */
export function assertAccountScope(ctx: AuthContext | undefined | null): asserts ctx is AuthContext {
  if (!ctx || !ctx.userId || !ctx.accountId) {
    throw new AppError("FORBIDDEN", "Missing or empty account scope");
  }
}

/** Runtime guard for global repositories — requires an authenticated user only. */
export function assertUser(ctx: AuthContext | undefined | null): asserts ctx is AuthContext {
  if (!ctx || !ctx.userId) {
    throw new AppError("FORBIDDEN", "Missing authenticated user");
  }
}

export interface ScopeOptions {
  archived?: "false" | "true" | "all";
}

/**
 * Backwards-compatible name for the account-scope guard. Module repositories
 * (which run custom archive/restore queries) call this before building a filter.
 * Declared as a function (not a `const` alias) so TS keeps its assertion
 * signature. Kept as a named export so those repos need no structural change.
 */
export function assertAuthContext(ctx: AuthContext | undefined | null): asserts ctx is AuthContext {
  assertAccountScope(ctx);
}

/**
 * Free-function account-scoped filter builder. Always applies `{ accountId }`
 * (fail-closed) — there is no longer a `scopeField` opt-out at the call site.
 * Used by module repositories for their custom archive/restore queries.
 */
export const buildScopedFilter = <T extends BaseDoc>(
  ctx: AuthContext,
  base: Record<string, unknown>,
  opts: ScopeOptions = {},
): Filter<T> => {
  const filter: Record<string, unknown> = { ...base, [ACCOUNT_SCOPE_FIELD]: ctx.accountId, deletedAt: null };
  if (opts.archived === "false" || opts.archived === undefined) filter.archivedAt = null;
  else if (opts.archived === "true") filter.archivedAt = { $ne: null };
  return filter as Filter<T>;
};

const nowIso = (): string => new Date().toISOString();

/**
 * Account-scoped repository (the default for all domain entities). Every query is
 * filtered by `{ accountId }` and every insert stamps it — fail-closed.
 */
export class BaseRepository<T extends BaseDoc> {
  constructor(protected readonly collection: Collection<T>) {}

  protected scopedFilter(ctx: AuthContext, base: Record<string, unknown>, opts: ScopeOptions = {}): Filter<T> {
    return buildScopedFilter<T>(ctx, base, opts);
  }

  async findById(ctx: AuthContext, id: string): Promise<T | null> {
    assertAccountScope(ctx);
    const doc = await this.collection.findOne(this.scopedFilter(ctx, { id }), { projection: { _id: 0 } });
    return (doc as T | null) ?? null;
  }

  async list(
    ctx: AuthContext,
    raw: Record<string, string | string[] | undefined>,
    whitelist: ListWhitelist,
  ): Promise<{ items: T[]; parsed: ParsedListQuery; total: number }> {
    assertAccountScope(ctx);
    const parsed = parseListQuery(raw, whitelist);
    const filter = this.scopedFilter(ctx, parsed.filter, { archived: parsed.archived });
    const cursor = this.collection
      .find(filter, { projection: { _id: 0 } })
      .sort(parsed.sort)
      .skip(parsed.skip)
      .limit(parsed.limit);
    const [items, total] = await Promise.all([
      cursor.toArray() as Promise<T[]>,
      this.collection.countDocuments(filter),
    ]);
    return { items, parsed, total };
  }

  async insert(ctx: AuthContext, data: Omit<T, keyof BaseDoc>): Promise<T> {
    assertAccountScope(ctx);
    const ts = nowIso();
    const doc = {
      ...data,
      id: new ObjectId().toHexString(),
      version: 1,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      deletedAt: null,
      [ACCOUNT_SCOPE_FIELD]: ctx.accountId,
    } as unknown as T;
    // Insert a COPY — the driver mutates its argument to add `_id`; returning the
    // original keeps the API document clean (we expose `id`, never `_id`).
    await this.collection.insertOne({ ...doc } as never);
    return doc;
  }

  /**
   * Optimistic-concurrency update: matches on `{accountId, id, version}`;
   * mismatch → `VERSION_CONFLICT` (409); absent → `RESOURCE_NOT_FOUND` (404).
   */
  async updateVersioned(ctx: AuthContext, id: string, expectedVersion: number, patch: Partial<T>): Promise<T> {
    assertAccountScope(ctx);
    const filter = this.scopedFilter(ctx, { id, version: expectedVersion });
    const result = await this.collection.findOneAndUpdate(
      filter,
      { $set: { ...patch, updatedAt: nowIso() }, $inc: { version: 1 } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (!result) {
      const exists = await this.collection.findOne(this.scopedFilter(ctx, { id }, { archived: "all" }), {
        projection: { id: 1 },
      });
      throw exists ? errors.versionConflict() : errors.notFound();
    }
    return result as T;
  }

  async softDelete(ctx: AuthContext, id: string): Promise<void> {
    assertAccountScope(ctx);
    await this.collection.updateOne(this.scopedFilter(ctx, { id }, { archived: "all" }), {
      $set: { deletedAt: nowIso() },
    } as never);
  }
}

/**
 * Repository for GLOBAL (non-tenant) collections — accounts, users, sessions.
 * Extending this is an explicit, reviewable declaration that a collection is NOT
 * account-scoped. It applies the same soft-delete / version / auth-guard
 * machinery but does NOT filter or stamp `accountId`. Use sparingly.
 */
export class GlobalRepository<T extends BaseDoc> {
  constructor(protected readonly collection: Collection<T>) {}

  protected globalFilter(base: Record<string, unknown>, opts: ScopeOptions = {}): Filter<T> {
    const filter: Record<string, unknown> = { ...base, deletedAt: null };
    if (opts.archived === "false" || opts.archived === undefined) filter.archivedAt = null;
    else if (opts.archived === "true") filter.archivedAt = { $ne: null };
    return filter as Filter<T>;
  }

  async findById(ctx: AuthContext, id: string): Promise<T | null> {
    assertUser(ctx);
    const doc = await this.collection.findOne(this.globalFilter({ id }), { projection: { _id: 0 } });
    return (doc as T | null) ?? null;
  }

  async list(
    ctx: AuthContext,
    raw: Record<string, string | string[] | undefined>,
    whitelist: ListWhitelist,
  ): Promise<{ items: T[]; parsed: ParsedListQuery; total: number }> {
    assertUser(ctx);
    const parsed = parseListQuery(raw, whitelist);
    const filter = this.globalFilter(parsed.filter, { archived: parsed.archived });
    const cursor = this.collection
      .find(filter, { projection: { _id: 0 } })
      .sort(parsed.sort)
      .skip(parsed.skip)
      .limit(parsed.limit);
    const [items, total] = await Promise.all([
      cursor.toArray() as Promise<T[]>,
      this.collection.countDocuments(filter),
    ]);
    return { items, parsed, total };
  }

  async insert(ctx: AuthContext, data: Omit<T, keyof BaseDoc>): Promise<T> {
    assertUser(ctx);
    const ts = nowIso();
    const doc = {
      ...data,
      id: new ObjectId().toHexString(),
      version: 1,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      deletedAt: null,
    } as unknown as T;
    await this.collection.insertOne({ ...doc } as never);
    return doc;
  }

  async updateVersioned(ctx: AuthContext, id: string, expectedVersion: number, patch: Partial<T>): Promise<T> {
    assertUser(ctx);
    const filter = this.globalFilter({ id, version: expectedVersion });
    const result = await this.collection.findOneAndUpdate(
      filter,
      { $set: { ...patch, updatedAt: nowIso() }, $inc: { version: 1 } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (!result) {
      const exists = await this.collection.findOne(this.globalFilter({ id }, { archived: "all" }), {
        projection: { id: 1 },
      });
      throw exists ? errors.versionConflict() : errors.notFound();
    }
    return result as T;
  }

  async softDelete(ctx: AuthContext, id: string): Promise<void> {
    assertUser(ctx);
    await this.collection.updateOne(this.globalFilter({ id }, { archived: "all" }), {
      $set: { deletedAt: nowIso() },
    } as never);
  }
}
