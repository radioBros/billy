import { type Collection, ObjectId } from "mongodb";
import type { AuthContext } from "@billy/types";
import { assertAuthContext } from "@/platform/repository.js";
import type {
  SettingsDataByKey,
  SettingsDoc,
  SettingsKey,
  UserSettingsData,
  UserSettingsDoc,
} from "@/modules/settings/types.js";

/**
 * Settings data access. NOT a `BaseRepository`: the account settings are
 * *singletons per (key, accountId)*, and per-user settings are keyed by `userId`
 * — neither fits the id/archive model of `BaseRepository`, so this is a small
 * dedicated store that scopes by hand.
 *
 * Every method takes the mandatory `authContext` and runs `assertAuthContext`.
 * The `key` singletons are scoped by `{ key, accountId }` so each account has its
 * OWN business/branding/tax/etc. settings. Per-user settings stay keyed by
 * `userId` (globally unique). Get-or-create uses an upsert with `$setOnInsert` so
 * the singleton/per-user default is minted atomically (no read-then-write race).
 */

export const SETTINGS_COLLECTION = "settings";
export const USER_SETTINGS_COLLECTION = "userSettings";

const nowIso = (): string => new Date().toISOString();

export class SettingsRepository {
  constructor(
    private readonly settings: Collection<SettingsDoc>,
    private readonly userSettings: Collection<UserSettingsDoc>,
  ) {}

  /** Get the singleton for `key`, creating it from `defaults` on first access. */
  async getOrCreate<K extends SettingsKey>(
    ctx: AuthContext,
    key: K,
    defaults: SettingsDataByKey[K],
  ): Promise<SettingsDoc> {
    assertAuthContext(ctx);
    const ts = nowIso();
    const result = await this.settings.findOneAndUpdate(
      { key, accountId: ctx.accountId } as never,
      {
        $setOnInsert: {
          key,
          accountId: ctx.accountId,
          data: defaults,
          id: new ObjectId().toHexString(),
          version: 1,
          createdAt: ts,
          updatedAt: ts,
          archivedAt: null,
          deletedAt: null,
        },
      } as never,
      { upsert: true, returnDocument: "after", projection: { _id: 0 } },
    );
    // With upsert + returnDocument:"after" the driver always returns the doc.
    return result as unknown as SettingsDoc;
  }

  /** Merge `patch` into the singleton's `data`, bumping `version`/`updatedAt`. */
  async updateData<K extends SettingsKey>(
    ctx: AuthContext,
    key: K,
    current: SettingsDataByKey[K],
    patch: Partial<SettingsDataByKey[K]>,
  ): Promise<SettingsDoc> {
    assertAuthContext(ctx);
    const merged = { ...current, ...patch };
    const result = await this.settings.findOneAndUpdate(
      { key, accountId: ctx.accountId } as never,
      { $set: { data: merged, updatedAt: nowIso() }, $inc: { version: 1 } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return result as unknown as SettingsDoc;
  }

  /** Get the per-user settings doc, creating it from `defaults` on first access. */
  async getOrCreateUser(
    ctx: AuthContext,
    userId: string,
    defaults: UserSettingsData,
  ): Promise<UserSettingsDoc> {
    assertAuthContext(ctx);
    const ts = nowIso();
    const result = await this.userSettings.findOneAndUpdate(
      { userId } as never,
      { $setOnInsert: { userId, ...defaults, createdAt: ts, updatedAt: ts } } as never,
      { upsert: true, returnDocument: "after", projection: { _id: 0 } },
    );
    return result as unknown as UserSettingsDoc;
  }

  /** Merge `patch` into the per-user settings doc (self-scoped by `userId`). */
  async updateUser(
    ctx: AuthContext,
    userId: string,
    current: UserSettingsData,
    patch: Partial<UserSettingsData>,
  ): Promise<UserSettingsDoc> {
    assertAuthContext(ctx);
    const merged = { ...current, ...patch };
    const result = await this.userSettings.findOneAndUpdate(
      { userId } as never,
      { $set: { ...merged, updatedAt: nowIso() } } as never,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return result as unknown as UserSettingsDoc;
  }
}
