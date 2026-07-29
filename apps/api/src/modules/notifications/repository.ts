import type { Collection, Filter } from "mongodb";
import type { AuthContext, BaseDoc, ListWhitelist } from "@billy/types";
import {
  BaseRepository,
  assertAuthContext,
  buildScopedFilter,
} from "@/platform/repository.js";
import { parseListQuery, type ParsedListQuery } from "@/platform/list-query.js";
import type { Notification, NotificationPreferences } from "@/modules/notifications/types.js";

/** Mongo collection names. */
export const NOTIFICATIONS_COLLECTION = "notifications";
export const PREFERENCES_COLLECTION = "notificationPreferences";

const nowIso = (): string => new Date().toISOString();

/**
 * Data access for the in-app Notification read model. Per-USER isolation is the
 * whole point of this module: a user must never see another user's notifications.
 *
 * IMPORTANT: BaseRepository's `scopeField` constructor arg binds the scope to
 * `ctx.accountId`, NOT `ctx.userId` (see platform/repository.ts
 * `buildScopedFilter` / `insert`). In a single-tenant deployment every user
 * shares one `accountId`, so scopeField would leak notifications across
 * users. This repository therefore does NOT use `scopeField` — it injects
 * `{ userId: ctx.userId }` into every filter itself, and stamps `userId` on insert.
 */
export class NotificationRepository extends BaseRepository<Notification> {
  constructor(collection: Collection<Notification>) {
    // No scopeField — we scope by ctx.userId explicitly (see class doc).
    super(collection);
  }

  /** userId-scoped base filter for read/update queries (defense in depth). */
  private userFilter(
    ctx: AuthContext,
    base: Record<string, unknown> = {},
    archived: "false" | "true" | "all" = "false",
  ): Filter<Notification> {
    return buildScopedFilter<Notification>(ctx, { ...base, userId: ctx.userId }, { archived });
  }

  override async findById(ctx: AuthContext, id: string): Promise<Notification | null> {
    assertAuthContext(ctx);
    const doc = await this.collection.findOne(this.userFilter(ctx, { id }), { projection: { _id: 0 } });
    return (doc as Notification | null) ?? null;
  }

  /** Insert a notification OWNED by `ctx.userId` (stamps userId + BaseDoc). */
  override async insert(
    ctx: AuthContext,
    data: Omit<Notification, keyof BaseDoc | "userId">,
  ): Promise<Notification> {
    assertAuthContext(ctx);
    // Route through the base insert but force userId = the owning user (ctx.userId).
    return super.insert(ctx, { ...data, userId: ctx.userId } as Omit<Notification, keyof BaseDoc>);
  }

  /**
   * List the caller's notifications, scoped to
   * `ctx.userId`. Unread-first: `readAt: 1` puts null (unread) before ISO dates,
   * then most-recent first. A caller-supplied `sort` (whitelisted) overrides.
   */
  override async list(
    ctx: AuthContext,
    raw: Record<string, string | string[] | undefined>,
    whitelist: ListWhitelist,
  ): Promise<{ items: Notification[]; parsed: ParsedListQuery; total: number }> {
    assertAuthContext(ctx);
    const parsed = parseListQuery(raw, whitelist);
    const filter = this.userFilter(ctx, parsed.filter, parsed.archived);
    const sort: Record<string, 1 | -1> =
      Object.keys(parsed.sort).length > 0 ? parsed.sort : { readAt: 1, createdAt: -1 };
    const cursor = this.collection
      .find(filter, { projection: { _id: 0 } })
      .sort(sort)
      .skip(parsed.skip)
      .limit(parsed.limit);
    const [items, total] = await Promise.all([
      cursor.toArray() as Promise<Notification[]>,
      this.collection.countDocuments(filter),
    ]);
    return { items, parsed, total };
  }

  /** Count the caller's unread (readAt null) notifications. */
  async countUnread(ctx: AuthContext): Promise<number> {
    assertAuthContext(ctx);
    return this.collection.countDocuments(this.userFilter(ctx, { readAt: null }));
  }

  /**
   * Mark one owned notification read (idempotent — only sets readAt if unread).
   * Returns the resulting doc, or null if not found / not owned by the caller.
   */
  async markRead(ctx: AuthContext, id: string): Promise<Notification | null> {
    assertAuthContext(ctx);
    const ts = nowIso();
    const result = await this.collection.findOneAndUpdate(
      this.userFilter(ctx, { id, readAt: null }),
      { $set: { readAt: ts, updatedAt: ts } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (result) return result as Notification;
    // Already read (idempotent) or genuinely absent — return current state (or null).
    return this.findById(ctx, id);
  }

  /** Mark all the caller's unread notifications read. Returns the count updated. */
  async markAllRead(ctx: AuthContext): Promise<number> {
    assertAuthContext(ctx);
    const ts = nowIso();
    const res = await this.collection.updateMany(
      this.userFilter(ctx, { readAt: null }),
      { $set: { readAt: ts, updatedAt: ts } } as never,
    );
    return res.modifiedCount;
  }
}

/**
 * Data access for per-user NotificationPreferences (one doc per user, keyed by
 * userId). Also userId-scoped. Upsert-by-userId keeps a single document per user.
 */
export class NotificationPreferencesRepository {
  constructor(private readonly collection: Collection<NotificationPreferences>) {}

  /** The caller's preferences doc, or null if none has been created yet. */
  async findForUser(ctx: AuthContext): Promise<NotificationPreferences | null> {
    assertAuthContext(ctx);
    const doc = await this.collection.findOne(
      { userId: ctx.userId, deletedAt: null } as Filter<NotificationPreferences>,
      { projection: { _id: 0 } },
    );
    return (doc as NotificationPreferences | null) ?? null;
  }

  /**
   * Merge `categories` into the caller's preferences, creating the doc on first
   * write (upsert). Bumps `version`/`updatedAt`; stamps BaseDoc on insert.
   */
  async upsertForUser(
    ctx: AuthContext,
    categories: NotificationPreferences["categories"],
  ): Promise<NotificationPreferences> {
    assertAuthContext(ctx);
    const ts = nowIso();
    const existing = await this.findForUser(ctx);
    if (existing) {
      const merged = { ...existing.categories, ...categories };
      const result = await this.collection.findOneAndUpdate(
        { userId: ctx.userId, deletedAt: null } as Filter<NotificationPreferences>,
        { $set: { categories: merged, updatedAt: ts }, $inc: { version: 1 } } as never,
        { returnDocument: "after", projection: { _id: 0 } },
      );
      return result as NotificationPreferences;
    }
    const doc: NotificationPreferences = {
      id: crypto.randomUUID(),
      userId: ctx.userId,
      categories,
      version: 1,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      deletedAt: null,
    };
    await this.collection.insertOne({ ...doc } as never);
    return doc;
  }
}
