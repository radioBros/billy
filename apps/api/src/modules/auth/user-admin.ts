import { z } from "zod";
import { ObjectId } from "mongodb";
import { AppError, type Logger } from "@billy/shared";
import type { AuthContext, Role } from "@billy/types";
import { Email, NonEmptyString } from "@billy/validation";
import { assertCapability, type DomainEventEmitter } from "@/platform/service.js";
import { hashPassword } from "@/modules/auth/password.js";
import {
  type UserStore,
  type User,
  type SafeUser,
  toSafeUser,
  CapabilitiesSchema,
  defaultCapabilitiesForRole,
  PasswordPolicy,
} from "@/modules/auth/users.js";
import type { AuthService } from "@/modules/auth/auth-service.js";

/**
 * Admin user management. Every method is gated server-side on the
 * `canManageUsers` capability (administrators bypass via `assertCapability`).
 * Privilege-escalation surface: role + capabilities are validated with zod, and
 * the LAST-ACTIVE-ADMIN invariant is enforced on every demote/disable/delete —
 * the system can never be left with zero administrators, and an admin cannot
 * lock themselves out by self-demoting the final admin.
 */

const RoleSchema = z.enum(["administrator", "member"]);

export const CreateUserSchema = z.object({
  email: Email,
  displayName: NonEmptyString,
  role: RoleSchema,
  password: PasswordPolicy,
  capabilities: CapabilitiesSchema.optional(),
});
export type CreateUserInput = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = z
  .object({
    displayName: NonEmptyString.optional(),
    role: RoleSchema.optional(),
    capabilities: CapabilitiesSchema.optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "no fields to update" });
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

export const ResetPasswordSchema = z.object({
  password: PasswordPolicy,
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;

export interface UserAdminDeps {
  users: UserStore;
  emitter: DomainEventEmitter;
  logger: Logger;
  /** Used to revoke sessions on disable / role change / password reset. */
  authService: AuthService;
  now?: () => number;
}

export class UserAdminService {
  private readonly users: UserStore;
  private readonly emitter: DomainEventEmitter;
  private readonly authService: AuthService;
  private readonly now: () => number;

  constructor(deps: UserAdminDeps) {
    this.users = deps.users;
    this.emitter = deps.emitter;
    this.authService = deps.authService;
    this.now = deps.now ?? (() => Date.now());
  }

  async list(ctx: AuthContext): Promise<SafeUser[]> {
    assertCapability(ctx, "canManageUsers");
    return (await this.users.list(ctx.accountId)).map(toSafeUser);
  }

  async create(ctx: AuthContext, input: CreateUserInput): Promise<SafeUser> {
    assertCapability(ctx, "canManageUsers");

    const email = input.email.toLowerCase();
    if (await this.users.findByEmail(email)) {
      throw new AppError("DUPLICATE_VALUE", "A user with this email already exists");
    }

    const nowMs = this.now();
    const iso = new Date(nowMs).toISOString();
    const user: User = {
      id: new ObjectId().toHexString(),
      version: 1,
      createdAt: iso,
      updatedAt: iso,
      archivedAt: null,
      deletedAt: null,
      email,
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      // New users belong to the creating admin's account. (A sysadmin creating a
      // user does so while an account is assumed, so ctx.accountId is that account.)
      accountId: ctx.accountId,
      capabilities: input.capabilities ?? defaultCapabilitiesForRole(input.role),
      status: "active",
      emailVerifiedAt: null,
      mustChangePassword: true, // force change on first login (admin-set initial pw)
      failedLoginCount: 0,
      lockedUntil: null,
      totpEnabled: false,
    };
    await this.users.create(user);
    void this.emitter.emit({ name: "user.created", actorId: ctx.userId, entityType: "user", entityId: user.id });
    return toSafeUser(user);
  }

  async update(ctx: AuthContext, id: string, input: UpdateUserInput): Promise<SafeUser> {
    assertCapability(ctx, "canManageUsers");
    const user = await this.users.findById(id);
    if (!user) throw new AppError("RESOURCE_NOT_FOUND", "User not found");

    const nextRole: Role = input.role ?? user.role;
    const nextStatus = input.status ?? user.status;

    // Last-admin invariant (PER ACCOUNT): block demoting or disabling the final
    // active administrator OF THAT USER'S ACCOUNT — otherwise the account's users
    // are stranded with no admin.
    const demotingFromAdmin = user.role === "administrator" && nextRole !== "administrator";
    const disablingAdmin = user.role === "administrator" && user.status === "active" && nextStatus !== "active";
    if (
      (demotingFromAdmin || disablingAdmin) &&
      user.accountId &&
      (await this.users.countActiveAdminsInAccount(user.accountId)) <= 1
    ) {
      throw new AppError("FORBIDDEN", "Cannot remove the last active administrator of this account");
    }
    // Last-sysadmin invariant (GLOBAL): never demote/disable the final sysadmin,
    // or nobody can manage accounts.
    const demotingFromSysadmin = user.role === "sysadmin" && nextRole !== "sysadmin";
    const disablingSysadmin = user.role === "sysadmin" && user.status === "active" && nextStatus !== "active";
    if ((demotingFromSysadmin || disablingSysadmin) && (await this.users.countActiveSysadmins()) <= 1) {
      throw new AppError("FORBIDDEN", "Cannot remove the last active system administrator");
    }

    const patch: Partial<User> = {};
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.role !== undefined) patch.role = input.role;
    if (input.status !== undefined) patch.status = input.status;
    if (input.capabilities !== undefined) patch.capabilities = input.capabilities;
    else if (input.role !== undefined && input.role !== user.role) {
      // Role changed without explicit capabilities → reset to the role default so a
      // demoted admin does not silently retain elevated capabilities.
      patch.capabilities = defaultCapabilitiesForRole(input.role);
    }

    await this.users.update(id, patch);

    // A privilege reduction or disable must invalidate outstanding sessions.
    if (demotingFromAdmin || disablingAdmin || input.capabilities !== undefined || input.role !== undefined) {
      await this.authService.revokeAll(id, nextStatus !== "active" ? "admin_revoked" : "privilege_change");
    }

    void this.emitter.emit({ name: "user.updated", actorId: ctx.userId, entityType: "user", entityId: id });
    const updated = await this.users.findById(id);
    return toSafeUser(updated ?? { ...user, ...patch });
  }

  async resetPassword(ctx: AuthContext, id: string, input: ResetPasswordInput): Promise<SafeUser> {
    assertCapability(ctx, "canManageUsers");
    const user = await this.users.findById(id);
    if (!user) throw new AppError("RESOURCE_NOT_FOUND", "User not found");

    await this.users.update(id, {
      passwordHash: await hashPassword(input.password),
      mustChangePassword: true,
      failedLoginCount: 0,
      lockedUntil: null,
    });
    await this.authService.revokeAll(id, "admin_revoked");
    void this.emitter.emit({ name: "user.password_reset", actorId: ctx.userId, entityType: "user", entityId: id });
    const updated = await this.users.findById(id);
    return toSafeUser(updated ?? user);
  }

  async softDelete(ctx: AuthContext, id: string): Promise<void> {
    assertCapability(ctx, "canManageUsers");
    const user = await this.users.findById(id);
    if (!user) throw new AppError("RESOURCE_NOT_FOUND", "User not found");

    // Last-admin invariant: never delete the final active administrator of the
    // account (per-account), nor the final global sysadmin.
    if (
      user.role === "administrator" &&
      user.status === "active" &&
      user.accountId &&
      (await this.users.countActiveAdminsInAccount(user.accountId)) <= 1
    ) {
      throw new AppError("FORBIDDEN", "Cannot delete the last active administrator of this account");
    }
    if (user.role === "sysadmin" && user.status === "active" && (await this.users.countActiveSysadmins()) <= 1) {
      throw new AppError("FORBIDDEN", "Cannot delete the last active system administrator");
    }

    const iso = new Date(this.now()).toISOString();
    await this.users.update(id, { deletedAt: iso, status: "disabled" });
    await this.authService.revokeAll(id, "admin_revoked");
    void this.emitter.emit({ name: "user.deleted", actorId: ctx.userId, entityType: "user", entityId: id });
  }
}
