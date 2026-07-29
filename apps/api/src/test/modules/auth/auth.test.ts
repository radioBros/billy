import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, dummyVerify } from "@/modules/auth/password.js";
import {
  generateSessionToken,
  hashSessionToken,
  computeExpiries,
  extendIdle,
  isSessionValid,
  sessionCookieOptions,
  IDLE_TTL_MS,
  ABSOLUTE_TTL_MS,
} from "@/modules/auth/session.js";
import { lockoutState, MAX_FAILS, LOCK_MS } from "@/modules/auth/lockout.js";

describe("password hashing (Argon2id)", () => {
  it("hashes then verifies the correct password, rejects a wrong one", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(h, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(h, "wrong")).toBe(false);
  });
  it("verifyPassword returns false for a malformed hash (no throw)", async () => {
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });
  it("dummyVerify always resolves false (enumeration defense)", async () => {
    expect(await dummyVerify("anything")).toBe(false);
  });
});

describe("session token", () => {
  it("generates a high-entropy token and a stable SHA-256 hash", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, "base64url").length).toBe(32); // 256-bit
    const h = hashSessionToken(a);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(a)).toBe(h); // deterministic
  });
});

describe("dual-clock expiry", () => {
  const now = 1_000_000_000_000;
  it("sets idle and absolute expiries from now", () => {
    const e = computeExpiries(now);
    expect(Date.parse(e.idleExpiresAt)).toBe(now + IDLE_TTL_MS);
    expect(Date.parse(e.absoluteExpiresAt)).toBe(now + ABSOLUTE_TTL_MS);
  });
  it("extends idle but never past the absolute cap", () => {
    const e = computeExpiries(now);
    const later = now + ABSOLUTE_TTL_MS - 1000; // near the hard cap
    const extended = extendIdle(e, later, IDLE_TTL_MS);
    expect(Date.parse(extended)).toBe(Date.parse(e.absoluteExpiresAt)); // capped
  });
  it("isSessionValid respects revoke + both clocks", () => {
    const e = computeExpiries(now);
    expect(isSessionValid(e, now + 1000)).toBe(true);
    expect(isSessionValid({ ...e, revokedAt: new Date(now).toISOString() }, now + 1000)).toBe(false);
    expect(isSessionValid(e, now + IDLE_TTL_MS + 1)).toBe(false); // idle passed
    expect(isSessionValid({ ...e, idleExpiresAt: e.absoluteExpiresAt }, now + ABSOLUTE_TTL_MS + 1)).toBe(false);
  });
});

describe("cookie policy", () => {
  it("is HttpOnly + SameSite=Lax; Secure only in prod", () => {
    expect(sessionCookieOptions({ isProd: true, maxAgeMs: 1000 })).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 1000,
    });
    expect(sessionCookieOptions({ isProd: false, maxAgeMs: 1000 }).secure).toBe(false);
  });
});

describe("brute-force lockout", () => {
  it("no backoff before threshold, escalating backoff, then lock", () => {
    expect(lockoutState(0)).toEqual({ locked: false, backoffMs: 0 });
    expect(lockoutState(3).backoffMs).toBe(1000);
    expect(lockoutState(4).backoffMs).toBe(2000);
    expect(lockoutState(MAX_FAILS)).toEqual({ locked: true, backoffMs: LOCK_MS });
  });
});
