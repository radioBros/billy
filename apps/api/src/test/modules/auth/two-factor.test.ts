import { describe, it, expect } from "vitest";
import { createLogger, AppError } from "@billy/shared";
import type { DomainEventEmitter } from "@/platform/service.js";
import { AuthService } from "@/modules/auth/auth-service.js";
import { seedFirstAdmin } from "@/modules/auth/first-run.js";
import type { User, UserStore } from "@/modules/auth/users.js";
import type { Session, SessionStore, RevokedReason } from "@/modules/auth/sessions.js";
import { generateSync } from "otplib";
import { decryptField } from "@/platform/crypto.js";
import type { TotpChallenge, TotpChallengeStore } from "@/modules/auth/totp.js";

// ── In-memory fakes ──────────────────────────────────────────────────────────

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
    return [...this.byId.values()].filter((u) => !u.deletedAt && u.accountId === accountId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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

class InMemoryChallengeStore implements TotpChallengeStore {
  readonly byHash = new Map<string, TotpChallenge>();
  async create(c: TotpChallenge) {
    this.byHash.set(c.tokenHash, c);
  }
  async findByTokenHash(hash: string) {
    return this.byHash.get(hash) ?? null;
  }
  async delete(hash: string) {
    this.byHash.delete(hash);
  }
}

const logger = createLogger({ level: "silent", pretty: false, service: "test" });
const emitter: DomainEventEmitter = { emit() {} };
const EMAIL = "admin@example.com";
const PASSWORD = "Correct-Horse-Battery-Staple-1";
const KEY = "unit-test-data-encryption-key-0123456789";

const newSvc = () => {
  const users = new InMemoryUserStore();
  const sessions = new InMemorySessionStore();
  const challenges = new InMemoryChallengeStore();
  const svc = new AuthService({ users, sessions, challenges, emitter, logger, encryptionKey: KEY });
  return { users, sessions, challenges, svc };
};

const seed = async (users: UserStore) => {
  await seedFirstAdmin({ users, emitter, logger, email: EMAIL, password: PASSWORD });
  return (await users.findByEmail(EMAIL))!;
};

const expectAppError = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toBeInstanceOf(AppError);
  await p.catch((e: unknown) => expect((e as AppError).code).toBe(code));
};

const authenticated = (o: Awaited<ReturnType<AuthService["login"]>>) => {
  if (o.status !== "authenticated") throw new Error(`expected authenticated, got ${o.status}`);
  return o;
};

/** Enable TOTP for a seeded user end-to-end; returns { secret, backupCodes }. */
const enableTotp = async (svc: AuthService, users: UserStore, userId: string) => {
  const setup = await svc.totpSetup(userId);
  const code = generateSync({ secret: setup.secret });
  const { backupCodes } = await svc.totpEnable(userId, code);
  return { secret: setup.secret, backupCodes };
};

// ── change-password ──────────────────────────────────────────────────────────

describe("change-password", () => {
  it("rejects a wrong current password with INVALID_CREDENTIALS", async () => {
    const { users, svc } = newSvc();
    const admin = await seed(users);
    await expectAppError(svc.changePassword(admin.id, "not-the-password", "Brand-New-Password-9"), "INVALID_CREDENTIALS");
  });

  it("rejects a new password below the policy length", async () => {
    const { users, svc } = newSvc();
    const admin = await seed(users);
    await expectAppError(svc.changePassword(admin.id, PASSWORD, "short"), "VALIDATION_FAILED");
  });

  it("updates the hash, clears mustChangePassword, and lets the new password log in", async () => {
    const { users, svc } = newSvc();
    const admin = await seed(users);
    expect(admin.mustChangePassword).toBe(true);
    await svc.changePassword(admin.id, PASSWORD, "Brand-New-Password-9");
    const after = (await users.findById(admin.id))!;
    expect(after.passwordHash).not.toBe(admin.passwordHash);
    expect(after.mustChangePassword).toBe(false);
    await expectAppError(svc.login(EMAIL, PASSWORD, "ip", "ua"), "INVALID_CREDENTIALS");
    const ok = authenticated(await svc.login(EMAIL, "Brand-New-Password-9", "ip", "ua"));
    expect(ok.token).toBeTruthy();
  });

  it("revokes other sessions on password change", async () => {
    const { users, sessions, svc } = newSvc();
    const admin = await seed(users);
    const first = authenticated(await svc.login(EMAIL, PASSWORD, "ip", "ua"));
    expect(await svc.resolve(first.token)).not.toBeNull();
    await svc.changePassword(admin.id, PASSWORD, "Brand-New-Password-9");
    expect(await svc.resolve(first.token)).toBeNull();
    // The revoke reason is the password-change reason.
    const s = [...sessions.byId.values()][0]!;
    expect(s.revokedReason).toBe("password_change");
  });
});

// ── TOTP enable (verify-before-enable) ───────────────────────────────────────

describe("TOTP setup + enable (verify-before-enable)", () => {
  it("setup stores an ENCRYPTED pending secret and does not enable", async () => {
    const { users, svc } = newSvc();
    const admin = await seed(users);
    const setup = await svc.totpSetup(admin.id);
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\//u);
    const stored = (await users.findById(admin.id))!;
    expect(stored.totpEnabled ?? false).toBe(false);
    expect(stored.totpPendingSecret).toBeTruthy();
    expect(stored.totpPendingSecret).not.toContain(setup.secret); // stored ciphertext, not plaintext
    expect(decryptField(stored.totpPendingSecret!, KEY)).toBe(setup.secret); // decrypts back
  });

  it("enable rejects a wrong code and does NOT enable", async () => {
    const { users, svc } = newSvc();
    const admin = await seed(users);
    await svc.totpSetup(admin.id);
    await expectAppError(svc.totpEnable(admin.id, "000000"), "TWO_FACTOR_INVALID");
    expect((await users.findById(admin.id))!.totpEnabled ?? false).toBe(false);
  });

  it("enable with a valid code enables 2FA and returns 10 backup codes", async () => {
    const { users, svc } = newSvc();
    const admin = await seed(users);
    const { backupCodes } = await enableTotp(svc, users, admin.id);
    expect(backupCodes).toHaveLength(10);
    const stored = (await users.findById(admin.id))!;
    expect(stored.totpEnabled).toBe(true);
    expect(stored.totpPendingSecret).toBeNull();
    expect(stored.totpBackupCodes).toHaveLength(10);
    // backup codes are stored HASHED, never in plaintext.
    for (const plain of backupCodes) expect(stored.totpBackupCodes).not.toContain(plain);
  });
});

// ── Login challenge (the core) ───────────────────────────────────────────────

describe("login 2FA challenge", () => {
  it("a 2FA user's login returns 2fa_required and NOT a session", async () => {
    const { users, svc } = newSvc();
    const admin = await seed(users);
    await enableTotp(svc, users, admin.id);
    const outcome = await svc.login(EMAIL, PASSWORD, "ip", "ua");
    expect(outcome.status).toBe("2fa_required");
    if (outcome.status !== "2fa_required") throw new Error("unreachable");
    expect(outcome.pendingToken).toBeTruthy();
  });

  it("verify-2fa with a valid TOTP code mints a session flagged amrTwoFactor=true", async () => {
    const { users, svc } = newSvc();
    const admin = await seed(users);
    const { secret } = await enableTotp(svc, users, admin.id);
    const outcome = await svc.login(EMAIL, PASSWORD, "ip", "ua");
    if (outcome.status !== "2fa_required") throw new Error("expected challenge");
    const code = generateSync({ secret });
    const result = await svc.verifyLoginTwoFactor(outcome.pendingToken, code, "ip", "ua");
    expect(result.token).toBeTruthy();
    expect(result.principal.amrTwoFactor).toBe(true);
    const resolved = await svc.resolve(result.token);
    expect(resolved?.session.amrTwoFactor).toBe(true);
  });

  it("verify-2fa rejects a wrong code and consumes the challenge is single-use", async () => {
    const { users, svc } = newSvc();
    const admin = await seed(users);
    await enableTotp(svc, users, admin.id);
    const outcome = await svc.login(EMAIL, PASSWORD, "ip", "ua");
    if (outcome.status !== "2fa_required") throw new Error("expected challenge");
    await expectAppError(svc.verifyLoginTwoFactor(outcome.pendingToken, "000000", "ip", "ua"), "INVALID_CREDENTIALS");
  });

  it("a pending token cannot be replayed after success", async () => {
    const { users, svc } = newSvc();
    const admin = await seed(users);
    const { secret } = await enableTotp(svc, users, admin.id);
    const outcome = await svc.login(EMAIL, PASSWORD, "ip", "ua");
    if (outcome.status !== "2fa_required") throw new Error("expected challenge");
    const code = generateSync({ secret });
    await svc.verifyLoginTwoFactor(outcome.pendingToken, code, "ip", "ua");
    // replay same token → rejected (challenge consumed)
    await expectAppError(svc.verifyLoginTwoFactor(outcome.pendingToken, generateSync({ secret }), "ip", "ua"), "INVALID_CREDENTIALS");
  });

  it("a backup code works once, then is invalidated", async () => {
    const { users, svc } = newSvc();
    const admin = await seed(users);
    const { backupCodes } = await enableTotp(svc, users, admin.id);
    const backup = backupCodes[0]!;

    const o1 = await svc.login(EMAIL, PASSWORD, "ip", "ua");
    if (o1.status !== "2fa_required") throw new Error("expected challenge");
    const r1 = await svc.verifyLoginTwoFactor(o1.pendingToken, backup, "ip", "ua");
    expect(r1.token).toBeTruthy();

    // Second attempt with the SAME backup code → rejected (single-use).
    const o2 = await svc.login(EMAIL, PASSWORD, "ip", "ua");
    if (o2.status !== "2fa_required") throw new Error("expected challenge");
    await expectAppError(svc.verifyLoginTwoFactor(o2.pendingToken, backup, "ip", "ua"), "INVALID_CREDENTIALS");
    expect((await users.findById(admin.id))!.totpBackupCodes).toHaveLength(9);
  });

  it("a non-2FA user's login is unchanged (authenticated immediately)", async () => {
    const { users, svc } = newSvc();
    await seed(users);
    const o = await svc.login(EMAIL, PASSWORD, "ip", "ua");
    expect(o.status).toBe("authenticated");
  });
});

// ── Disable requires re-auth ─────────────────────────────────────────────────

describe("TOTP disable requires re-auth", () => {
  it("rejects disable with no valid credential", async () => {
    const { users, svc } = newSvc();
    const admin = await seed(users);
    await enableTotp(svc, users, admin.id);
    await expectAppError(svc.totpDisable(admin.id, { code: "000000" }), "INVALID_CREDENTIALS");
    expect((await users.findById(admin.id))!.totpEnabled).toBe(true);
  });

  it("disables with a valid TOTP code and clears all 2FA fields", async () => {
    const { users, svc } = newSvc();
    const admin = await seed(users);
    const { secret } = await enableTotp(svc, users, admin.id);
    await svc.totpDisable(admin.id, { code: generateSync({ secret }) });
    const after = (await users.findById(admin.id))!;
    expect(after.totpEnabled).toBe(false);
    expect(after.totpSecret).toBeNull();
    expect(after.totpBackupCodes).toBeNull();
  });

  it("disables with the account password", async () => {
    const { users, svc } = newSvc();
    const admin = await seed(users);
    await enableTotp(svc, users, admin.id);
    await svc.totpDisable(admin.id, { password: PASSWORD });
    expect((await users.findById(admin.id))!.totpEnabled).toBe(false);
  });
});
