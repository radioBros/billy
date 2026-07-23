import { describe, it, expect, beforeAll } from "vitest";
import { createLogger, AppError } from "@billy/shared";
import type { DomainEventEmitter } from "@/platform/service.js";
import { AuthService } from "@/modules/auth/auth-service.js";
import { seedFirstAdmin } from "@/modules/auth/first-run.js";
import type { User, UserStore } from "@/modules/auth/users.js";
import type { Session, SessionStore, RevokedReason } from "@/modules/auth/sessions.js";
import { MAX_FAILS } from "@/modules/auth/lockout.js";

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
    return [...this.byId.values()]
      .filter((u) => u.role === "administrator" && u.status === "active" && !u.deletedAt && u.accountId === accountId)
      .map((u) => u.id);
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
const EMAIL = "admin@example.com";
const PASSWORD = "Correct-Horse-Battery-Staple-1";

const newSvc = () => {
  const users = new InMemoryUserStore();
  const sessions = new InMemorySessionStore();
  const svc = new AuthService({ users, sessions, emitter, logger });
  return { users, sessions, svc };
};

const expectInvalidCredentials = async (p: Promise<unknown>) => {
  await expect(p).rejects.toBeInstanceOf(AppError);
  await p.catch((e: unknown) => expect((e as AppError).code).toBe("INVALID_CREDENTIALS"));
};

/** Narrow a login outcome to the authenticated case (throws if a 2FA challenge). */
const expectAuthenticated = (outcome: Awaited<ReturnType<AuthService["login"]>>) => {
  if (outcome.status !== "authenticated") throw new Error(`expected authenticated, got ${outcome.status}`);
  return outcome;
};

describe("auth flow (first-run seed → login → resolve → logout)", () => {
  it("seeds exactly one admin, idempotently", async () => {
    const { users } = newSvc();
    const first = await seedFirstAdmin({ users, emitter, logger, email: EMAIL, password: PASSWORD });
    expect(first.seeded).toBe(true);
    const second = await seedFirstAdmin({ users, emitter, logger, email: EMAIL, password: PASSWORD });
    expect(second.seeded).toBe(false); // idempotent — admin already exists
    expect(await users.countActiveAdmins()).toBe(1);
  });

  it("logs in a seeded admin and resolves the session → authContext", async () => {
    const { users, svc } = newSvc();
    await seedFirstAdmin({ users, emitter, logger, email: EMAIL, password: PASSWORD });
    const res = expectAuthenticated(await svc.login(EMAIL, PASSWORD, "127.0.0.1", "vitest"));
    expect(res.principal.role).toBe("sysadmin");
    expect(res.token).toBeTruthy();
    const resolved = await svc.resolve(res.token);
    expect(resolved?.authContext.userId).toBe(res.principal.id);
    expect(resolved?.authContext.accountId).toBe("default");
  });

  it("logout revokes the session (resolve → null after)", async () => {
    const { users, svc } = newSvc();
    await seedFirstAdmin({ users, emitter, logger, email: EMAIL, password: PASSWORD });
    const res = expectAuthenticated(await svc.login(EMAIL, PASSWORD, "ip", "ua"));
    await svc.logout(res.token);
    expect(await svc.resolve(res.token)).toBeNull();
  });

  it("wrong password and unknown email both → INVALID_CREDENTIALS (enumeration-safe)", async () => {
    const { users, svc } = newSvc();
    await seedFirstAdmin({ users, emitter, logger, email: EMAIL, password: PASSWORD });
    await expectInvalidCredentials(svc.login(EMAIL, "wrong", "ip", "ua"));
    await expectInvalidCredentials(svc.login("nobody@example.com", "whatever", "ip", "ua"));
  });

  it("locks the account after too many failures", async () => {
    const { users, svc } = newSvc();
    await seedFirstAdmin({ users, emitter, logger, email: EMAIL, password: PASSWORD });
    for (let i = 0; i < MAX_FAILS; i++) await expectInvalidCredentials(svc.login(EMAIL, "wrong", "ip", "ua"));
    // now locked: even the CORRECT password is rejected uniformly
    await expectInvalidCredentials(svc.login(EMAIL, PASSWORD, "ip", "ua"));
  });
});
