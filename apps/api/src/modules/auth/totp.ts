import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { Collection } from "mongodb";
import { generateSecret, generateURI, verifySync } from "otplib";
import { hashPassword, verifyPassword } from "@/modules/auth/password.js";

/**
 * TOTP primitives + the pending-2FA challenge store.
 *
 * Design:
 *  - **Secret at rest is encrypted** by the caller (auth-service) via
 *    `encryptField`; this module only produces/consumes the plaintext base32.
 *  - **Verify-before-enable.** Setup produces a *pending* secret; it is promoted
 *    to the live secret only after a code proves the authenticator is provisioned.
 *  - **Backup codes** are single-use recovery codes. Only their SHA-256 (fast,
 *    high-entropy input → no need for argon2's slowness) — wait: we hash with
 *    argon2 to match the password-at-rest bar and resist offline guessing even
 *    though entropy is high. Stored HASHED, matched in constant time by argon2.
 *  - **Pending-2FA challenge.** When a 2FA user passes password auth, login does
 *    NOT mint a session; it issues a short-lived opaque `pendingToken` whose
 *    SHA-256 is stored here bound to the userId. `/login/verify-2fa` exchanges a
 *    valid, unexpired, unconsumed challenge (after a correct code) for a full
 *    session. Single-use: consumed on success.
 */

// ── TOTP config ──────────────────────────────────────────────────────────────

const TOTP_ISSUER = "Billy";
/** ±1 time-step (30s) tolerance for clock drift — otplib takes seconds. */
const TOTP_EPOCH_TOLERANCE = 30;

export interface TotpSetup {
  secret: string; // base32 plaintext — caller encrypts before persisting
  otpauthUrl: string;
}

export const createTotpSecret = (userEmail: string): TotpSetup => {
  const secret = generateSecret();
  const otpauthUrl = generateURI({ issuer: TOTP_ISSUER, label: userEmail, secret });
  return { secret, otpauthUrl };
};

/** Verify a 6-digit code against a base32 secret (constant-time inside otplib). */
export const verifyTotpCode = (secret: string, code: string): boolean => {
  const token = code.replace(/\s+/gu, "");
  if (!/^\d{6}$/u.test(token)) return false;
  try {
    return verifySync({ secret, token, epochTolerance: TOTP_EPOCH_TOLERANCE }).valid;
  } catch {
    return false;
  }
};

// ── Backup codes ─────────────────────────────────────────────────────────────

export const BACKUP_CODE_COUNT = 10;

/** A human-friendly code like `a1b2c3d4` (32 bits of entropy, base32-ish hex). */
const oneBackupCode = (): string => randomBytes(5).toString("hex").slice(0, 10);

/** Generate N plaintext backup codes + their argon2 hashes (store the hashes). */
export const generateBackupCodes = async (
  count = BACKUP_CODE_COUNT,
): Promise<{ plaintext: string[]; hashes: string[] }> => {
  const plaintext = Array.from({ length: count }, oneBackupCode);
  const hashes = await Promise.all(plaintext.map((c) => hashPassword(c)));
  return { plaintext, hashes };
};

/**
 * Try to consume a backup code. Returns the REMAINING hashes (the matched one
 * removed) on success, or null if no stored hash matches. Single-use enforced by
 * the caller persisting the returned array.
 */
export const consumeBackupCode = async (
  hashes: readonly string[] | null | undefined,
  code: string,
): Promise<string[] | null> => {
  const candidate = code.replace(/\s+/gu, "").toLowerCase();
  if (!hashes || hashes.length === 0 || !candidate) return null;
  for (let i = 0; i < hashes.length; i++) {
    if (await verifyPassword(hashes[i]!, candidate)) {
      return [...hashes.slice(0, i), ...hashes.slice(i + 1)];
    }
  }
  return null;
};

// ── Pending-2FA challenge store ──────────────────────────────────────────────

export interface TotpChallenge {
  /** SHA-256 of the opaque pending token — raw token never stored. */
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  ip: string;
  userAgent: string;
}

export interface TotpChallengeStore {
  create(challenge: TotpChallenge): Promise<void>;
  findByTokenHash(hash: string): Promise<TotpChallenge | null>;
  /** Single-use: delete on consume so a token can never be replayed. */
  delete(tokenHash: string): Promise<void>;
}

/** 5-minute window to complete the second factor. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export const generatePendingToken = (): string => randomBytes(32).toString("base64url");
export const hashPendingToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export const isChallengeValid = (c: TotpChallenge, nowMs: number): boolean => {
  return nowMs < Date.parse(c.expiresAt);
};

/** Constant-time equality for two same-length hex hashes (defensive). */
export const timingSafeEqualHex = (a: string, b: string): boolean => {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
};

export class MongoTotpChallengeStore implements TotpChallengeStore {
  constructor(private readonly col: Collection<TotpChallenge>) {}
  async create(challenge: TotpChallenge): Promise<void> {
    await this.col.insertOne(challenge as never);
  }
  async findByTokenHash(hash: string): Promise<TotpChallenge | null> {
    return (await this.col.findOne({ tokenHash: hash }, { projection: { _id: 0 } })) as TotpChallenge | null;
  }
  async delete(tokenHash: string): Promise<void> {
    await this.col.deleteOne({ tokenHash });
  }
}
