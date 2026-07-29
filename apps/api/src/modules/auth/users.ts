import { z } from "zod";
import type { Collection } from "mongodb";
import type { AuthContext, BaseDoc, Capabilities, Role } from "@billy/types";
import { Email, NonEmptyString } from "@billy/validation";

/**
 * User entity + the pre-auth user store (auth subsystem). The login path runs
 * BELOW the authContext layer (you can't have an authContext before you
 * authenticate), so this store queries the collection directly with the
 * soft-delete filter — the documented exception to the mandatory-authContext
 * rule. Post-auth admin user CRUD uses a BaseRepository.
 */
export interface User extends BaseDoc {
  email: string;
  displayName: string;
  passwordHash: string;
  role: Role;
  capabilities: Capabilities;
  /**
   * The account this user belongs to. `null` ONLY for the global sysadmin, who
   * belongs to no single account and assumes one per session. Every other user
   * is bound to exactly one account (one-user-one-account model).
   */
  accountId: string | null;
  status: "invited" | "active" | "disabled";
  emailVerifiedAt?: string | null;
  mustChangePassword?: boolean;
  failedLoginCount?: number;
  lockedUntil?: string | null;
  /**
   * TOTP two-factor. `totpSecret` is the base32 secret
   * ENCRYPTED at rest via {@link encryptField} — never stored or returned in the
   * clear. `totpPendingSecret` holds an enrolment secret that is not yet
   * confirmed (verify-before-enable); it is promoted to `totpSecret` only once a
   * live code proves the user has provisioned their authenticator. Backup codes
   * are stored HASHED (argon2), one-time use.
   */
  totpSecret?: string | null;
  totpPendingSecret?: string | null;
  totpEnabled?: boolean;
  totpBackupCodes?: string[] | null;
  /** Consecutive failed 2FA-code verifications since the last success (lockout). */
  totpFailedCount?: number;
  totpLockedUntil?: string | null;
}

export const CapabilitiesSchema = z.object({
  canManageSettings: z.boolean(),
  canManageUsers: z.boolean(),
  canPermanentlyDelete: z.boolean(),
  canViewFinancialTotals: z.boolean(),
  canExportData: z.boolean(),
});

export const LoginBodySchema = z.object({
  email: Email,
  password: NonEmptyString,
});

export const fullCapabilities = (): Capabilities => {
  return {
    canManageSettings: true,
    canManageUsers: true,
    canPermanentlyDelete: true,
    canViewFinancialTotals: true,
    canExportData: true,
  };
};

/** No capabilities — the baseline a plain member gets unless explicitly granted. */
export const noCapabilities = (): Capabilities => {
  return {
    canManageSettings: false,
    canManageUsers: false,
    canPermanentlyDelete: false,
    canViewFinancialTotals: false,
    canExportData: false,
  };
};

/** Default capability set implied by a role (admin ⇒ full, member ⇒ none). */
export const defaultCapabilitiesForRole = (role: Role): Capabilities => {
  return role === "administrator" ? fullCapabilities() : noCapabilities();
};

/**
 * Minimum length for an interactively-set password (change-password, admin
 * reset, create). The login path only requires `NonEmptyString` (it must accept
 * whatever was previously set), but any NEW password must clear this bar.
 */
export const MIN_PASSWORD_LENGTH = 8;
export const PasswordPolicy = z.string().min(MIN_PASSWORD_LENGTH, { message: "password.tooShort" }).max(200);

/**
 * The default account id. Used as the fallback tenant for a non-sysadmin user
 * that (legacy) has no accountId, AND as the fixed id of the "Default" account
 * created by the backfill migration — so pre- and post-migration data line up
 * under one value. Must stay literally "default".
 */
export const DEFAULT_ACCOUNT_ID = "default";

/** Principal projection returned by /auth/me and login (no secrets). */
export interface Principal {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  capabilities: Capabilities;
  mustChangePassword: boolean;
  amrTwoFactor: boolean;
  /** True for the global sysadmin (web shows the account switcher). */
  isSysadmin: boolean;
  /** The account this principal is operating within (own, or a sysadmin's assumed). */
  accountId: string;
}

export const toPrincipal = (user: User, amrTwoFactor: boolean, activeAccountId?: string | null): Principal => {
  const isSysadmin = user.role === "sysadmin";
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    capabilities: user.capabilities,
    mustChangePassword: user.mustChangePassword ?? false,
    amrTwoFactor,
    isSysadmin,
    accountId: isSysadmin ? activeAccountId ?? DEFAULT_ACCOUNT_ID : user.accountId ?? DEFAULT_ACCOUNT_ID,
  };
};

/**
 * Admin-facing user view. NEVER contains passwordHash, totpSecret,
 * totpPendingSecret, or backup codes — only whether 2FA is on.
 */
export interface SafeUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  capabilities: Capabilities;
  status: User["status"];
  mustChangePassword: boolean;
  totpEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export const toSafeUser = (user: User): SafeUser => {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    capabilities: user.capabilities,
    status: user.status,
    mustChangePassword: user.mustChangePassword ?? false,
    totpEnabled: user.totpEnabled ?? false,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
};

/**
 * Build the request AuthContext from the authenticated user and (for a sysadmin)
 * the account they have currently assumed via their session.
 *
 * - Normal user: scoped to their own `user.accountId` (fallback to the default
 *   account for legacy/unmigrated users).
 * - Sysadmin: scoped to `activeAccountId` (the account they assumed). Until they
 *   assume one, they operate against the default account. `isSysadmin` marks the
 *   principal so the narrow cross-account management endpoints can authorize.
 */
export const authContextFor = (user: User, activeAccountId?: string | null): AuthContext => {
  const isSysadmin = user.role === "sysadmin";
  const accountId = isSysadmin
    ? activeAccountId ?? DEFAULT_ACCOUNT_ID
    : user.accountId ?? DEFAULT_ACCOUNT_ID;
  return {
    userId: user.id,
    role: user.role,
    capabilities: user.capabilities,
    accountId,
    isSysadmin,
  };
};

/** Store interface — injectable so the service is unit-testable with in-memory fakes. */
export interface UserStore {
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  create(user: User): Promise<void>;
  update(id: string, patch: Partial<User>): Promise<void>;
  /** Global count of active admins/sysadmins — gates first-run bootstrap. */
  countActiveAdmins(): Promise<number>;
  /** Active administrators WITHIN an account — the per-account last-admin guard. */
  countActiveAdminsInAccount(accountId: string): Promise<number>;
  /** Global count of active sysadmins — the last-sysadmin guard. */
  countActiveSysadmins(): Promise<number>;
  /** Ids of active administrators IN AN ACCOUNT — the default notification recipients. */
  listActiveAdminIds(accountId: string): Promise<string[]>;
  /** Non-deleted users IN AN ACCOUNT (admin CRUD). Sorted by createdAt asc. */
  list(accountId: string): Promise<User[]>;
}

export class MongoUserStore implements UserStore {
  constructor(private readonly col: Collection<User>) {}
  async findByEmail(email: string): Promise<User | null> {
    return (await this.col.findOne({ email: email.toLowerCase(), deletedAt: null }, { projection: { _id: 0 } })) as User | null;
  }
  async findById(id: string): Promise<User | null> {
    return (await this.col.findOne({ id, deletedAt: null }, { projection: { _id: 0 } })) as User | null;
  }
  async create(user: User): Promise<void> {
    await this.col.insertOne(user as never);
  }
  async update(id: string, patch: Partial<User>): Promise<void> {
    await this.col.updateOne({ id }, { $set: { ...patch, updatedAt: new Date().toISOString() } } as never);
  }
  async countActiveAdmins(): Promise<number> {
    // Global: counts admins AND sysadmins across the whole stack — gates the
    // first-run bootstrap ("is there any privileged user yet?").
    return this.col.countDocuments({
      role: { $in: ["administrator", "sysadmin"] },
      status: "active",
      deletedAt: null,
    });
  }
  async countActiveAdminsInAccount(accountId: string): Promise<number> {
    return this.col.countDocuments({ role: "administrator", status: "active", deletedAt: null, accountId });
  }
  async countActiveSysadmins(): Promise<number> {
    return this.col.countDocuments({ role: "sysadmin", status: "active", deletedAt: null });
  }
  async listActiveAdminIds(accountId: string): Promise<string[]> {
    const rows = await this.col
      .find({ role: "administrator", status: "active", deletedAt: null, accountId }, { projection: { _id: 0, id: 1 } })
      .toArray();
    return rows.map((r) => (r as { id: string }).id);
  }
  async list(accountId: string): Promise<User[]> {
    return (await this.col
      .find({ deletedAt: null, accountId }, { projection: { _id: 0 } })
      .sort({ createdAt: 1 })
      .toArray()) as User[];
  }
}
