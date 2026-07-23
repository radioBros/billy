import { ObjectId } from "mongodb";
import type { Logger } from "@billy/shared";
import type { DomainEventEmitter } from "@/platform/service.js";
import { hashPassword } from "@/modules/auth/password.js";
import { type UserStore, type User, fullCapabilities } from "@/modules/auth/users.js";

/**
 * First-run SYSADMIN bootstrap. Idempotent: aborts if ANY active administrator
 * OR sysadmin already exists, so it is safe to run on every boot. Reads
 * BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD (prompted for at install) and
 * creates the GLOBAL sysadmin (role "sysadmin", accountId null) with
 * `mustChangePassword`. The sysadmin then creates accounts + their users. No HTTP
 * surface — runs as a startup hook, preserving "no public registration".
 */
export interface SeedResult {
  seeded: boolean;
  reason?: string;
}

export const seedFirstAdmin = async (deps: {
  users: UserStore;
  emitter: DomainEventEmitter;
  logger: Logger;
  email?: string;
  password?: string;
  now?: () => number;
}): Promise<SeedResult> => {
  const existing = await deps.users.countActiveAdmins();
  if (existing > 0) return { seeded: false, reason: "admin_exists" };
  if (!deps.email || !deps.password) {
    deps.logger.warn("first-run: no active admin and BOOTSTRAP_ADMIN_EMAIL/PASSWORD not set — skipping seed");
    return { seeded: false, reason: "no_bootstrap_env" };
  }

  const nowMs = (deps.now ?? (() => Date.now()))();
  const iso = new Date(nowMs).toISOString();
  const user: User = {
    id: new ObjectId().toHexString(),
    version: 1,
    createdAt: iso,
    updatedAt: iso,
    archivedAt: null,
    deletedAt: null,
    email: deps.email.toLowerCase(),
    displayName: "System Administrator",
    passwordHash: await hashPassword(deps.password),
    role: "sysadmin",
    accountId: null, // global — belongs to no single account
    capabilities: fullCapabilities(),
    status: "active",
    emailVerifiedAt: iso,
    mustChangePassword: true, // forced change on first login
    failedLoginCount: 0,
    lockedUntil: null,
  };
  await deps.users.create(user);
  void deps.emitter.emit({ name: "auth.admin_bootstrapped", actorId: null, entityType: "user", entityId: user.id });
  deps.logger.info({ email: user.email }, "first-run: seeded global sysadmin (must change password on first login)");
  return { seeded: true };
};
