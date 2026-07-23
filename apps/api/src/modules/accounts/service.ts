import { ObjectId, type Db } from "mongodb";
import type { AuthContext } from "@billy/types";
import { AppError, errors, type Logger } from "@billy/shared";
import type { DomainEventEmitter } from "@/platform/service.js";
import { AccountRepository } from "@/modules/accounts/repository.js";
import type { Account } from "@/modules/accounts/types.js";
import type { AccountCreateInput, AccountUpdateInput } from "@/modules/accounts/schema.js";
import {
  type UserStore,
  type User,
  fullCapabilities,
} from "@/modules/auth/users.js";
import { hashPassword, verifyPassword } from "@/modules/auth/password.js";

/**
 * Every account-scoped collection. The destructive delete purges each of these
 * by `accountId`; the migration/isolation test reuse the same list. Keep this in
 * sync when a new account-scoped entity is added. (Global collections — accounts,
 * users, sessions, totp_challenges — are intentionally absent; user purge is
 * handled explicitly.)
 */
export const ACCOUNT_SCOPED_COLLECTIONS: readonly string[] = [
  "clients",
  "invoices",
  "quotes",
  "proformas",
  "creditNotes",
  "contracts",
  "subscriptions",
  "recurringProfiles",
  "expenses",
  "timeEntries",
  "files",
  "notifications",
  "notificationPreferences",
  "projects",
  "settings",
  "counters",
  "shareTokens",
  "pushSubscriptions",
];

const slugify = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "account";

export class AccountService {
  private readonly repo: AccountRepository;
  private readonly users: UserStore;
  private readonly db: Db;
  private readonly emitter: DomainEventEmitter;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(deps: {
    repo: AccountRepository;
    users: UserStore;
    db: Db;
    emitter: DomainEventEmitter;
    logger: Logger;
    now?: () => number;
  }) {
    this.repo = deps.repo;
    this.users = deps.users;
    this.db = deps.db;
    this.emitter = deps.emitter;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Sysadmin-only guard. */
  private assertSysadmin(ctx: AuthContext): void {
    if (!ctx.isSysadmin) throw new AppError("FORBIDDEN", "Sysadmin only");
  }

  async list(ctx: AuthContext): Promise<Account[]> {
    this.assertSysadmin(ctx);
    return this.repo.listAll(ctx);
  }

  async get(ctx: AuthContext, id: string): Promise<Account> {
    this.assertSysadmin(ctx);
    const acc = await this.repo.findByIdRaw(id);
    if (!acc || acc.deletedAt) throw errors.notFound();
    return acc;
  }

  /** Create an account and (optionally) its first account admin. */
  async create(ctx: AuthContext, input: AccountCreateInput): Promise<Account> {
    this.assertSysadmin(ctx);
    const slug = input.slug ? input.slug : slugify(input.name);
    if (await this.repo.findBySlug(slug)) {
      throw new AppError("DUPLICATE_VALUE", "An account with this slug already exists");
    }
    // GlobalRepository.insert stamps id/version/timestamps.
    const account = await this.repo.insert(ctx, {
      name: input.name,
      slug,
      status: "active",
      note: input.note ?? null,
    } as Omit<Account, "id" | "version" | "createdAt" | "updatedAt" | "archivedAt" | "deletedAt">);

    if (input.admin) {
      const email = input.admin.email.toLowerCase();
      if (await this.users.findByEmail(email)) {
        // Roll back the account so we don't orphan it.
        await this.repo.softDelete(ctx, account.id);
        throw new AppError("DUPLICATE_VALUE", "A user with this email already exists");
      }
      const iso = new Date(this.now()).toISOString();
      const admin: User = {
        id: new ObjectId().toHexString(),
        version: 1,
        createdAt: iso,
        updatedAt: iso,
        archivedAt: null,
        deletedAt: null,
        email,
        displayName: input.admin.displayName,
        passwordHash: await hashPassword(input.admin.password),
        role: "administrator",
        accountId: account.id,
        capabilities: fullCapabilities(),
        status: "active",
        emailVerifiedAt: iso,
        mustChangePassword: true,
        failedLoginCount: 0,
        lockedUntil: null,
      };
      await this.users.create(admin);
    }

    void this.emitter.emit({
      name: "account.created",
      actorId: ctx.userId,
      entityType: "account",
      entityId: account.id,
    });
    return account;
  }

  async update(ctx: AuthContext, id: string, expectedVersion: number, patch: AccountUpdateInput): Promise<Account> {
    this.assertSysadmin(ctx);
    if (patch.slug) {
      const bySlug = await this.repo.findBySlug(patch.slug);
      if (bySlug && bySlug.id !== id) {
        throw new AppError("DUPLICATE_VALUE", "An account with this slug already exists");
      }
    }
    return this.repo.updateVersioned(ctx, id, expectedVersion, patch as Partial<Account>);
  }

  /**
   * Destructively delete an account and ALL its data. Guarded: the caller must
   * echo the exact account name and re-supply the sysadmin password (verified
   * here). Purges every account-scoped collection by accountId, deletes the
   * account's users, then removes the account. Irreversible.
   */
  async destroy(ctx: AuthContext, id: string, confirm: { confirmName: string; password: string }): Promise<void> {
    this.assertSysadmin(ctx);
    const account = await this.repo.findByIdRaw(id);
    if (!account || account.deletedAt) throw errors.notFound();

    if (confirm.confirmName.trim() !== account.name.trim()) {
      throw new AppError("VALIDATION_FAILED", "Confirmation name does not match the account name");
    }
    const sysadmin = await this.users.findById(ctx.userId);
    if (!sysadmin || !(await verifyPassword(sysadmin.passwordHash, confirm.password))) {
      throw new AppError("FORBIDDEN", "Password verification failed");
    }

    // Purge every account-scoped collection.
    for (const name of ACCOUNT_SCOPED_COLLECTIONS) {
      // settings/counters are keyed by accountId too (migration adds it).
      const res = await this.db.collection(name).deleteMany({ accountId: id });
      this.logger.info({ accountId: id, collection: name, deleted: res.deletedCount }, "account purge");
    }
    // Delete the account's users (global collection, filtered by accountId).
    await this.db.collection("users").deleteMany({ accountId: id });
    // Finally the account itself (hard delete — nothing references it anymore).
    await this.db.collection("accounts").deleteOne({ id });

    void this.emitter.emit({
      name: "account.deleted",
      actorId: ctx.userId,
      entityType: "account",
      entityId: id,
    });
    this.logger.warn({ accountId: id, name: account.name }, "account permanently deleted (all data purged)");
  }
}
