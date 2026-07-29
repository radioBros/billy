import { randomBytes, createHash } from "node:crypto";

/**
 * Session token + dual-clock expiry logic. The cookie
 * carries an opaque ≥256-bit CSPRNG token; only its SHA-256 hash is stored, so a
 * DB read cannot reconstruct a valid cookie. Pure — unit-tested without infra.
 */

export const SESSION_COOKIE_NAME = "billy_session";
export const IDLE_TTL_MS = 8 * 60 * 60 * 1000; // 8h sliding
export const ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d hard cap

export const generateSessionToken = (): string => {
  return randomBytes(32).toString("base64url");
};

export const hashSessionToken = (token: string): string => {
  return createHash("sha256").update(token).digest("hex");
};

export interface Expiries {
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

export const computeExpiries = (nowMs: number, idleTtlMs = IDLE_TTL_MS, absoluteTtlMs = ABSOLUTE_TTL_MS): Expiries => {
  return {
    idleExpiresAt: new Date(nowMs + idleTtlMs).toISOString(),
    absoluteExpiresAt: new Date(nowMs + absoluteTtlMs).toISOString(),
  };
};

export const extendIdle = (e: Expiries, nowMs: number, idleTtlMs = IDLE_TTL_MS): string => {
  const target = nowMs + idleTtlMs;
  const cap = Date.parse(e.absoluteExpiresAt);
  return new Date(Math.min(target, cap)).toISOString();
};

export const isSessionValid = (s: { idleExpiresAt: string; absoluteExpiresAt: string; revokedAt?: string | null }, nowMs: number): boolean => {
  if (s.revokedAt) return false;
  return nowMs < Date.parse(s.idleExpiresAt) && nowMs < Date.parse(s.absoluteExpiresAt);
};

export interface CookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number; // ms
}

export const sessionCookieOptions = (opts: { isProd: boolean; maxAgeMs: number }): CookieOptions => {
  return { httpOnly: true, secure: opts.isProd, sameSite: "lax", path: "/", maxAge: opts.maxAgeMs };
};
