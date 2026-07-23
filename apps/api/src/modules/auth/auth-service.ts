import { ObjectId } from "mongodb";
import { AppError, type Logger } from "@billy/shared";
import type { AuthContext } from "@billy/types";
import type { DomainEventEmitter } from "@/platform/service.js";
import { encryptField, decryptField } from "@/platform/crypto.js";
import { hashPassword, verifyPassword, dummyVerify } from "@/modules/auth/password.js";
import {
  generateSessionToken,
  hashSessionToken,
  computeExpiries,
  extendIdle,
  isSessionValid,
} from "@/modules/auth/session.js";
import { lockoutState, LOCK_MS, MAX_FAILS } from "@/modules/auth/lockout.js";
import {
  type UserStore,
  type User,
  type Principal,
  toPrincipal,
  authContextFor,
  PasswordPolicy,
} from "@/modules/auth/users.js";
import type { SessionStore, Session, RevokedReason } from "@/modules/auth/sessions.js";
import {
  type TotpChallengeStore,
  type TotpChallenge,
  createTotpSecret,
  verifyTotpCode,
  generateBackupCodes,
  consumeBackupCode,
  generatePendingToken,
  hashPendingToken,
  isChallengeValid,
  CHALLENGE_TTL_MS,
} from "@/modules/auth/totp.js";

export interface AuthServiceDeps {
  users: UserStore;
  sessions: SessionStore;
  emitter: DomainEventEmitter;
  logger: Logger;
  /** Two-factor challenge store (pending-2FA login state). Optional so legacy tests without 2FA still construct. */
  challenges?: TotpChallengeStore;
  /** Key material for TOTP-secret field encryption (config.DATA_ENCRYPTION_KEY). */
  encryptionKey?: string;
  /** injectable clock for deterministic tests */
  now?: () => number;
  /**
   * Minimal account lookup for the sysadmin assume-account flow (verifies the
   * target account exists + is active). Optional so legacy constructions still work.
   */
  accounts?: { findByIdRaw(id: string): Promise<{ deletedAt?: string | null; status: string } | null> };
}

export interface LoginResult {
  token: string;
  maxAgeMs: number;
  principal: Principal;
}

/** Login outcome: either a full session, or a 2FA challenge the client must complete. */
export type LoginOutcome =
  | ({ status: "authenticated" } & LoginResult)
  | { status: "2fa_required"; pendingToken: string; expiresInMs: number };

export interface ResolvedSession {
  user: User;
  session: Session;
  authContext: AuthContext;
  principal: Principal;
}

export class AuthService {
  private readonly users: UserStore;
  private readonly sessions: SessionStore;
  private readonly emitter: DomainEventEmitter;
  private readonly logger: Logger;
  private readonly challenges?: TotpChallengeStore;
  private readonly encryptionKey?: string;
  private readonly now: () => number;
  private readonly accounts?: AuthServiceDeps["accounts"];

  constructor(deps: AuthServiceDeps) {
    this.users = deps.users;
    this.sessions = deps.sessions;
    this.emitter = deps.emitter;
    this.logger = deps.logger;
    this.challenges = deps.challenges;
    this.encryptionKey = deps.encryptionKey;
    this.now = deps.now ?? (() => Date.now());
    this.accounts = deps.accounts;
  }

  /**
   * Login. Enumeration-safe (dummy verify on unknown/
   * inactive user, uniform INVALID_CREDENTIALS), per-account lockout, session
   * rotation on success (a fresh session; no fixation).
   */
  async login(email: string, password: string, ip: string, ua: string): Promise<LoginOutcome> {
    const nowMs = this.now();
    const user = await this.users.findByEmail(email);

    if (!user || user.status !== "active") {
      await dummyVerify(password); // spend comparable time
      throw invalidCredentials();
    }

    if (user.lockedUntil && Date.parse(user.lockedUntil) > nowMs) {
      this.emitLoginFailed(user.id, "locked");
      throw invalidCredentials();
    }

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) {
      const fails = (user.failedLoginCount ?? 0) + 1;
      const state = lockoutState(fails);
      await this.users.update(user.id, {
        failedLoginCount: fails,
        lockedUntil: state.locked ? new Date(nowMs + LOCK_MS).toISOString() : (user.lockedUntil ?? null),
      });
      this.emitLoginFailed(user.id, "bad_password");
      throw invalidCredentials();
    }

    // Password correct — reset lockout counters.
    if (user.failedLoginCount) {
      await this.users.update(user.id, { failedLoginCount: 0, lockedUntil: null });
    }

    // Second factor gate: a 2FA-enabled user does NOT get a session yet — issue a
    // short-lived pending challenge that /login/verify-2fa must complete.
    if (user.totpEnabled) {
      return this.issueChallenge(user, ip, ua, nowMs);
    }

    return this.completeLogin(user, ip, ua, nowMs, false);
  }

  /** Password-verified 2FA user → issue a single-use pending challenge (no session yet). */
  private async issueChallenge(user: User, ip: string, ua: string, nowMs: number): Promise<LoginOutcome> {
    if (!this.challenges) {
      throw new AppError("INTERNAL_ERROR", "2FA challenge store not configured");
    }
    const pendingToken = generatePendingToken();
    const challenge: TotpChallenge = {
      tokenHash: hashPendingToken(pendingToken),
      userId: user.id,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + CHALLENGE_TTL_MS).toISOString(),
      ip,
      userAgent: ua,
    };
    await this.challenges.create(challenge);
    this.emit("auth.two_factor_challenged", user.id, user.id);
    return { status: "2fa_required", pendingToken, expiresInMs: CHALLENGE_TTL_MS };
  }

  /** Mint + persist a full session and return the authenticated outcome. */
  private async completeLogin(
    user: User,
    ip: string,
    ua: string,
    nowMs: number,
    amrTwoFactor: boolean,
  ): Promise<LoginOutcome> {
    const { token, session } = this.mintSession(user, ip, ua, nowMs, amrTwoFactor);
    await this.sessions.create(session);
    this.emit("auth.login", user.id, user.id);
    return {
      status: "authenticated",
      token,
      maxAgeMs: Date.parse(session.idleExpiresAt) - nowMs,
      principal: toPrincipal(user, session.amrTwoFactor),
    };
  }

  /**
   * Complete the second factor. Exchanges a valid pending
   * challenge for a full session, after verifying a live TOTP code OR consuming a
   * single-use backup code. Enumeration-safe: any failure → INVALID_CREDENTIALS
   * (the challenge token is the only thing the client holds; a bad token and a
   * bad code are indistinguishable). Per-account lockout on repeated bad codes.
   */
  async verifyLoginTwoFactor(pendingToken: string, code: string, ip: string, ua: string): Promise<LoginResult> {
    if (!this.challenges) {
      throw new AppError("INTERNAL_ERROR", "2FA challenge store not configured");
    }
    const nowMs = this.now();
    const challenge = await this.challenges.findByTokenHash(hashPendingToken(pendingToken));
    if (!challenge || !isChallengeValid(challenge, nowMs)) {
      if (challenge) await this.challenges.delete(challenge.tokenHash);
      throw invalidCredentials();
    }

    const user = await this.users.findById(challenge.userId);
    if (!user || user.status !== "active" || !user.totpEnabled) {
      await this.challenges.delete(challenge.tokenHash);
      throw invalidCredentials();
    }

    // Code-verification lockout (independent of the password lockout).
    if (user.totpLockedUntil && Date.parse(user.totpLockedUntil) > nowMs) {
      throw invalidCredentials();
    }

    const secret = this.decryptSecret(user.totpSecret);
    const totpOk = secret ? verifyTotpCode(secret, code) : false;

    let backupConsumed = false;
    if (!totpOk) {
      const remaining = await consumeBackupCode(user.totpBackupCodes, code);
      if (remaining) {
        backupConsumed = true;
        await this.users.update(user.id, { totpBackupCodes: remaining });
      }
    }

    if (!totpOk && !backupConsumed) {
      const fails = (user.totpFailedCount ?? 0) + 1;
      const locked = fails >= MAX_FAILS;
      await this.users.update(user.id, {
        totpFailedCount: fails,
        totpLockedUntil: locked ? new Date(nowMs + LOCK_MS).toISOString() : (user.totpLockedUntil ?? null),
      });
      this.emitLoginFailed(user.id, "bad_2fa");
      throw invalidCredentials();
    }

    // Success — consume the single-use challenge, reset 2FA lockout, mint session.
    await this.challenges.delete(challenge.tokenHash);
    if (user.totpFailedCount || user.totpLockedUntil) {
      await this.users.update(user.id, { totpFailedCount: 0, totpLockedUntil: null });
    }
    if (backupConsumed) this.emit("auth.two_factor_backup_used", user.id, user.id);
    const outcome = await this.completeLogin(user, ip, ua, nowMs, true);
    // completeLogin always returns "authenticated" here.
    const { status: _s, ...result } = outcome as { status: "authenticated" } & LoginResult;
    return result;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    const s = await this.sessions.findByTokenHash(hashSessionToken(token));
    if (s && !s.revokedAt) {
      await this.sessions.revoke(s.id, "logout");
      this.emit("auth.logout", s.userId, s.id);
    }
  }

  /** Resolve a cookie token → principal/authContext, or null. */
  async resolve(token: string | undefined): Promise<ResolvedSession | null> {
    if (!token) return null;
    const nowMs = this.now();
    const session = await this.sessions.findByTokenHash(hashSessionToken(token));
    if (!session || !isSessionValid(session, nowMs)) return null;
    const user = await this.users.findById(session.userId);
    if (!user || user.status !== "active") return null;
    // Only a sysadmin's assumed account is honored. For a normal user the
    // session's activeAccountId is IGNORED — authContextFor keys off
    // user.accountId, so a non-sysadmin can never move their own scope.
    const activeAccountId = user.role === "sysadmin" ? session.activeAccountId ?? null : null;
    return {
      user,
      session,
      authContext: authContextFor(user, activeAccountId),
      principal: toPrincipal(user, session.amrTwoFactor, activeAccountId),
    };
  }

  /**
   * SYSADMIN account switch: set the session's active account. Hard-gated to the
   * sysadmin role — any other caller is rejected. The next request resolves under
   * the assumed account. Verifies the target account exists + is active.
   */
  async assumeAccount(token: string | undefined, accountId: string): Promise<boolean> {
    if (!token) return false;
    const session = await this.sessions.findByTokenHash(hashSessionToken(token));
    if (!session || !isSessionValid(session, this.now())) return false;
    const user = await this.users.findById(session.userId);
    if (!user || user.status !== "active" || user.role !== "sysadmin") return false;
    const account = await this.accounts?.findByIdRaw(accountId);
    if (!account || account.deletedAt || account.status !== "active") return false;
    await this.sessions.update(session.id, { activeAccountId: accountId });
    return true;
  }

  /** Sliding-expiry renewal. Returns new maxAge + principal. */
  async refresh(token: string | undefined): Promise<LoginResult | null> {
    const resolved = await this.resolve(token);
    if (!resolved || !token) return null;
    const nowMs = this.now();
    const newIdle = extendIdle(resolved.session, nowMs);
    await this.sessions.updateIdle(resolved.session.id, newIdle, new Date(nowMs).toISOString());
    return { token, maxAgeMs: Date.parse(newIdle) - nowMs, principal: resolved.principal };
  }

  private mintSession(
    user: User,
    ip: string,
    ua: string,
    nowMs: number,
    amrTwoFactor: boolean,
  ): { token: string; session: Session } {
    const token = generateSessionToken();
    const exp = computeExpiries(nowMs);
    const iso = new Date(nowMs).toISOString();
    const session: Session = {
      id: new ObjectId().toHexString(),
      sessionTokenHash: hashSessionToken(token),
      userId: user.id,
      createdAt: iso,
      lastSeenAt: iso,
      idleExpiresAt: exp.idleExpiresAt,
      absoluteExpiresAt: exp.absoluteExpiresAt,
      revokedAt: null,
      revokedReason: null,
      ipAddress: ip,
      userAgent: ua,
      // true only after the second factor completed. A
      // password-only login of a non-2FA user stays false.
      amrTwoFactor,
    };
    return { token, session };
  }

  // ── TOTP field-encryption helpers ──────────────────────────────────────────

  private encryptSecret(plaintext: string): string {
    if (!this.encryptionKey) throw new AppError("INTERNAL_ERROR", "encryption key not configured");
    return encryptField(plaintext, this.encryptionKey);
  }

  private decryptSecret(ciphertext: string | null | undefined): string | null {
    if (!ciphertext || !this.encryptionKey) return null;
    try {
      return decryptField(ciphertext, this.encryptionKey);
    } catch {
      return null;
    }
  }

  // ── Self-service password change ────────────────────────────────────────────

  /**
   * Change the caller's own password. Re-authenticates with `currentPassword`
   * (uniform INVALID_CREDENTIALS on mismatch), enforces the password policy,
   * clears `mustChangePassword`, and revokes all OTHER sessions (a password
   * change invalidates outstanding sessions — session fixation defence). The
   * caller's current session token is preserved.
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user || user.status !== "active") throw invalidCredentials();

    const ok = await verifyPassword(user.passwordHash, currentPassword);
    if (!ok) {
      this.emitLoginFailed(user.id, "change_password_bad_current");
      throw invalidCredentials();
    }

    const parsed = PasswordPolicy.safeParse(newPassword);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "New password does not meet the minimum policy");
    }

    const passwordHash = await hashPassword(newPassword);
    await this.users.update(user.id, { passwordHash, mustChangePassword: false });
    await this.sessions.revokeAllForUser(user.id, "password_change");
    this.emit("auth.password_changed", user.id, user.id);
  }

  // ── TOTP enrolment ──────────────────────────────────────────────────────────

  /**
   * Begin TOTP enrolment. Generates a fresh secret, stores it ENCRYPTED as the
   * *pending* secret (not yet enabled — verify-before-enable), and returns the
   * otpauth URL for the client to render as a QR code. Re-running replaces any
   * prior pending secret.
   */
  async totpSetup(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.users.findById(userId);
    if (!user || user.status !== "active") throw new AppError("UNAUTHENTICATED", "Not authenticated");
    if (user.totpEnabled) throw new AppError("FORBIDDEN", "Two-factor is already enabled");

    const { secret, otpauthUrl } = createTotpSecret(user.email);
    await this.users.update(user.id, { totpPendingSecret: this.encryptSecret(secret) });
    return { secret, otpauthUrl };
  }

  /**
   * Confirm enrolment: verify a live code against the PENDING secret, then
   * promote it to the live secret, set `totpEnabled`, and mint + return N
   * one-time backup codes (plaintext ONCE; stored hashed). Backup codes are
   * mandatory recovery — returned here and never again.
   */
  async totpEnable(userId: string, code: string): Promise<{ backupCodes: string[] }> {
    const user = await this.users.findById(userId);
    if (!user || user.status !== "active") throw new AppError("UNAUTHENTICATED", "Not authenticated");
    if (user.totpEnabled) throw new AppError("FORBIDDEN", "Two-factor is already enabled");

    const pending = this.decryptSecret(user.totpPendingSecret);
    if (!pending) throw new AppError("FORBIDDEN", "No pending two-factor setup — call setup first");
    if (!verifyTotpCode(pending, code)) throw new AppError("TWO_FACTOR_INVALID", "Invalid verification code");

    const { plaintext, hashes } = await generateBackupCodes();
    await this.users.update(user.id, {
      totpSecret: this.encryptSecret(pending),
      totpPendingSecret: null,
      totpEnabled: true,
      totpBackupCodes: hashes,
      totpFailedCount: 0,
      totpLockedUntil: null,
    });
    this.emit("auth.two_factor_enabled", user.id, user.id);
    return { backupCodes: plaintext };
  }

  /**
   * Disable TOTP. Requires re-authentication: a valid current TOTP code OR the
   * account password. Clears the secret, backup codes, and enabled flag.
   */
  async totpDisable(userId: string, opts: { code?: string; password?: string }): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user || user.status !== "active") throw new AppError("UNAUTHENTICATED", "Not authenticated");
    if (!user.totpEnabled) throw new AppError("FORBIDDEN", "Two-factor is not enabled");

    const reauthed = await this.reauthenticate(user, opts);
    if (!reauthed) throw invalidCredentials();

    await this.users.update(user.id, {
      totpSecret: null,
      totpPendingSecret: null,
      totpEnabled: false,
      totpBackupCodes: null,
      totpFailedCount: 0,
      totpLockedUntil: null,
    });
    this.emit("auth.two_factor_disabled", user.id, user.id);
  }

  /** Re-auth for a sensitive action: a valid live TOTP code OR the password. */
  private async reauthenticate(user: User, opts: { code?: string; password?: string }): Promise<boolean> {
    if (opts.code) {
      const secret = this.decryptSecret(user.totpSecret);
      if (secret && verifyTotpCode(secret, opts.code)) return true;
      if (await consumeBackupCode(user.totpBackupCodes, opts.code)) {
        // A backup code proves possession; it's about to be wiped on disable anyway.
        return true;
      }
    }
    if (opts.password) {
      if (await verifyPassword(user.passwordHash, opts.password)) return true;
    }
    return false;
  }

  private emit(name: string, actorId: string | null, entityId: string): void {
    void this.emitter.emit({ name, actorId, entityType: "session", entityId });
  }
  private emitLoginFailed(userId: string, _reason: string): void {
    void this.emitter.emit({ name: "auth.login_failed", actorId: userId, entityType: "user", entityId: userId });
  }

  /** Revoke all of a user's sessions (password change etc.). */
  async revokeAll(userId: string, reason: RevokedReason): Promise<void> {
    await this.sessions.revokeAllForUser(userId, reason);
  }
}

const invalidCredentials = (): AppError => {
  return new AppError("INVALID_CREDENTIALS", "Invalid credentials");
};
