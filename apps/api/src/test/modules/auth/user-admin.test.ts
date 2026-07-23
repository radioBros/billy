import { describe, it, expect } from "vitest";
import { createLogger, AppError } from "@billy/shared";
import type { AuthContext } from "@billy/types";
import type { DomainEventEmitter } from "@/platform/service.js";
import { AuthService } from "@/modules/auth/auth-service.js";
import { seedFirstAdmin } from "@/modules/auth/first-run.js";
import {
  type User,
  type UserStore,
  authContextFor,
  fullCapabilities,
  noCapabilities,
} from "@/modules/auth/users.js";
import type { Session, SessionStore, RevokedReason } from "@/modules/auth/sessions.js";
import { UserAdminService } from "@/modules/auth/user-admin.js";

class InMemoryUserStore implements UserStore {
  readonly byId = new Map<string, User>();
  async findByEmail(email: string) {
    return [...this.byId.values()].find((u) => u.email === email.toLowerCase() && !u.deletedAt) ?? null;
  }
  async findById(id: string) {
    const u = this.byId.get(id);
    return u && !u.deletedAt ? u : null;
  }
  async create(u: User) {
    this.byId.set(u.id, u);
  }
  async update(id: string, patch: Partial<User>) {
    const u = this.byId.get(id);
    if (u) this.byId.set(id, { ...u, ...patch });
  }
  async countActiveAdmins() {
    return [...this.byId.values()].filter((u) => (u.role === "administrator" || u.role === "sysadmin") && u.status === "active" && !u.deletedAt).length;
  }
  async countActiveAdminsInAccount(accountId: string) {
    return [...this.byId.values()].filter((u) => u.role === "administrator" && u.status === "active" && !u.deletedAt && u.accountId === accountId).length;
  }
  async countActiveSysadmins() {
    return [...this.byId.values()].filter((u) => u.role === "sysadmin" && u.status === "active" && !u.deletedAt).length;
  }
  async listActiveAdminIds(accountId: string) {
    return [...this.byId.values()].filter((u) => u.role === "administrator" && u.status === "active" && !u.deletedAt && u.accountId === accountId).map((u) => u.id);
  }
  async list(accountId: string) {
    return [...this.byId.values()]
      .filter((u) => !u.deletedAt && u.accountId === accountId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

class InMemorySessionStore implements SessionStore {
  readonly byId = new Map<string, Session>();
  async create(s: Session) {
    this.byId.set(s.id, s);
  }
  async findByTokenHash(hash: string) {
    return [...this.byId.values()].find((s) => s.sessionTokenHash === hash) ?? null;
  }
  async updateIdle(id: string, idleExpiresAt: string, lastSeenAt: string) {
    const s = this.byId.get(id);
    if (s) this.byId.set(id, { ...s, idleExpiresAt, lastSeenAt });
  }
  async update(id: string, patch: Partial<Session>) {
    const s = this.byId.get(id);
    if (s) this.byId.set(id, { ...s, ...patch });
  }
  async revoke(id: string, reason: RevokedReason) {
    const s = this.byId.get(id);
    if (s) this.byId.set(id, { ...s, revokedAt: new Date().toISOString(), revokedReason: reason });
  }
  async revokeAllForUser(userId: string, reason: RevokedReason) {
    for (const [id, s] of this.byId) if (s.userId === userId && !s.revokedAt) await this.revoke(id, reason);
  }
}

const logger = createLogger({ level: "silent", pretty: false, service: "test" });
const emitter: DomainEventEmitter = { emit() {} };
const ADMIN_EMAIL = "admin@example.com";
const PASSWORD = "Correct-Horse-Battery-Staple-1";

const setup = async () => {
  const users = new InMemoryUserStore();
  const sessions = new InMemorySessionStore();
  const authService = new AuthService({ users, sessions, emitter, logger });
  const admin = new UserAdminService({ users, emitter, logger, authService });
  // Seed the global sysadmin (first-run), then create an ACCOUNT administrator in
  // "default" — the last-admin guard protects the account admin (per-account), so
  // the guard fixtures operate on this account admin, not the global sysadmin.
  await seedFirstAdmin({ users, emitter, logger, email: "sysadmin@example.com", password: PASSWORD });
  const sysadmin = (await users.findByEmail("sysadmin@example.com"))!;
  const sysadminCtx = authContextFor(sysadmin, "default");
  await admin.create(sysadminCtx, {
    email: ADMIN_EMAIL,
    displayName: "Account Admin",
    password: PASSWORD,
    role: "administrator",
  });
  const adminUser = (await users.findByEmail(ADMIN_EMAIL))!;
  const adminCtx = authContextFor(adminUser);
  return { users, sessions, authService, admin, adminUser, adminCtx, sysadminCtx };
};

/** A member auth-context with an explicit capability set. */
const memberCtx = (canManageUsers: boolean): AuthContext => ({
  userId: "member-1",
  role: "member",
  capabilities: { ...noCapabilities(), canManageUsers },
  accountId: "default",
});

const expectAppError = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toBeInstanceOf(AppError);
  await p.catch((e: unknown) => expect((e as AppError).code).toBe(code));
};

const validCreate = {
  email: "new@example.com",
  displayName: "New User",
  role: "member" as const,
  password: "Initial-Password-123",
};

describe("user admin — canManageUsers gate", () => {
  it("blocks a member WITHOUT canManageUsers on every method (CAPABILITY_DENIED)", async () => {
    const { admin } = await setup();
    const ctx = memberCtx(false);
    await expectAppError(admin.list(ctx), "CAPABILITY_DENIED");
    await expectAppError(admin.create(ctx, validCreate), "CAPABILITY_DENIED");
    await expectAppError(admin.update(ctx, "x", { displayName: "y" }), "CAPABILITY_DENIED");
    await expectAppError(admin.resetPassword(ctx, "x", { password: "New-Password-123" }), "CAPABILITY_DENIED");
    await expectAppError(admin.softDelete(ctx, "x"), "CAPABILITY_DENIED");
  });

  it("a member WITH canManageUsers can list", async () => {
    const { admin } = await setup();
    const list = await admin.list(memberCtx(true));
    expect(list.length).toBe(1);
    // list never leaks secrets
    expect(Object.keys(list[0]!)).not.toContain("passwordHash");
    expect(Object.keys(list[0]!)).not.toContain("totpSecret");
  });
});

describe("user admin — create", () => {
  it("creates a user with mustChangePassword=true and role-default capabilities", async () => {
    const { admin, adminCtx } = await setup();
    const created = await admin.create(adminCtx, validCreate);
    expect(created.mustChangePassword).toBe(true);
    expect(created.role).toBe("member");
    expect(created.capabilities).toEqual(noCapabilities());
  });

  it("an admin-created user with role=administrator gets full capabilities by default", async () => {
    const { admin, adminCtx } = await setup();
    const created = await admin.create(adminCtx, { ...validCreate, email: "a2@example.com", role: "administrator" });
    expect(created.capabilities).toEqual(fullCapabilities());
  });

  it("rejects a duplicate email", async () => {
    const { admin, adminCtx } = await setup();
    await admin.create(adminCtx, validCreate);
    await expectAppError(admin.create(adminCtx, validCreate), "DUPLICATE_VALUE");
  });
});

describe("user admin — last-admin guard", () => {
  it("blocks disabling the last active admin", async () => {
    const { admin, adminCtx, adminUser } = await setup();
    await expectAppError(admin.update(adminCtx, adminUser.id, { status: "disabled" }), "FORBIDDEN");
  });

  it("blocks demoting the last active admin", async () => {
    const { admin, adminCtx, adminUser } = await setup();
    await expectAppError(admin.update(adminCtx, adminUser.id, { role: "member" }), "FORBIDDEN");
  });

  it("blocks deleting the last active admin", async () => {
    const { admin, adminCtx, adminUser } = await setup();
    await expectAppError(admin.softDelete(adminCtx, adminUser.id), "FORBIDDEN");
  });

  it("allows demoting an admin once a SECOND admin exists", async () => {
    const { users, admin, adminCtx, adminUser } = await setup();
    await admin.create(adminCtx, { ...validCreate, email: "a2@example.com", role: "administrator" });
    // The guard is per-account: "default" now has 2 active administrators, so
    // demoting one is allowed.
    expect(await users.countActiveAdminsInAccount("default")).toBe(2);
    const demoted = await admin.update(adminCtx, adminUser.id, { role: "member" });
    expect(demoted.role).toBe("member");
    // demotion resets capabilities to the role default
    expect(demoted.capabilities).toEqual(noCapabilities());
  });
});

describe("user admin — update + reset + delete side effects", () => {
  it("disabling a (non-last) admin revokes their sessions", async () => {
    const { authService, admin, adminCtx } = await setup();
    const second = await admin.create(adminCtx, { ...validCreate, email: "a2@example.com", role: "administrator" });
    const login = await authService.login("a2@example.com", validCreate.password, "ip", "ua");
    if (login.status !== "authenticated") throw new Error("expected authenticated");
    expect(await authService.resolve(login.token)).not.toBeNull();
    await admin.update(adminCtx, second.id, { status: "disabled" });
    expect(await authService.resolve(login.token)).toBeNull();
  });

  it("reset-password sets mustChangePassword, revokes sessions, and the new password logs in", async () => {
    const { authService, admin, adminCtx } = await setup();
    const u = await admin.create(adminCtx, validCreate);
    const first = await authService.login(validCreate.email, validCreate.password, "ip", "ua");
    if (first.status !== "authenticated") throw new Error("expected authenticated");
    await admin.resetPassword(adminCtx, u.id, { password: "Admin-Reset-Password-9" });
    expect(await authService.resolve(first.token)).toBeNull(); // revoked
    const relogin = await authService.login(validCreate.email, "Admin-Reset-Password-9", "ip", "ua");
    expect(relogin.status).toBe("authenticated");
  });

  it("soft-delete removes the user from list and blocks login", async () => {
    const { authService, admin, adminCtx } = await setup();
    const u = await admin.create(adminCtx, validCreate);
    await admin.softDelete(adminCtx, u.id);
    const list = await admin.list(adminCtx);
    expect(list.find((x) => x.id === u.id)).toBeUndefined();
    await expectAppError(authService.login(validCreate.email, validCreate.password, "ip", "ua"), "INVALID_CREDENTIALS");
  });
});
