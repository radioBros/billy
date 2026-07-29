import { describe, it, expect } from "vitest";
import { encryptField, decryptField } from "@/platform/crypto.js";

/**
 * Field-encryption primitive tests (encryption-at-rest ENC-4 testing reqs):
 * round-trip, ciphertext is not plaintext, tamper → throw, wrong key → throw.
 */

const KEY = "test-data-encryption-key-32-bytes-minimum-abc";
const OTHER_KEY = "a-completely-different-key-value-also-long-xyz";

describe("crypto — encryptField/decryptField (AES-256-GCM)", () => {
  it("round-trips plaintext through encrypt → decrypt", () => {
    const plain = "super-secret-smtp-password!";
    const ct = encryptField(plain, KEY);
    expect(decryptField(ct, KEY)).toBe(plain);
  });

  it("produces a versioned v1:iv:tag:ct string that does not contain the plaintext", () => {
    const plain = "hunter2";
    const ct = encryptField(plain, KEY);
    expect(ct.startsWith("v1:")).toBe(true);
    expect(ct.split(":")).toHaveLength(4);
    expect(ct.includes(plain)).toBe(false);
  });

  it("uses a fresh IV each call → same plaintext yields different ciphertext", () => {
    const a = encryptField("same", KEY);
    const b = encryptField("same", KEY);
    expect(a).not.toBe(b);
    // ...but both decrypt back to the same value.
    expect(decryptField(a, KEY)).toBe("same");
    expect(decryptField(b, KEY)).toBe("same");
  });

  it("handles empty string and unicode round-trips", () => {
    expect(decryptField(encryptField("", KEY), KEY)).toBe("");
    const u = "pá$$wörd — 日本語 🔐";
    expect(decryptField(encryptField(u, KEY), KEY)).toBe(u);
  });

  /** Flip the first byte of a base64url segment (tamper helper). */
  function flipFirstByte(b64: string): string {
    const buf = Buffer.from(b64, "base64url");
    buf.set([(buf.at(0) ?? 0) ^ 0xff], 0);
    return buf.toString("base64url");
  }

  it("throws on a tampered ciphertext (auth tag no longer verifies)", () => {
    const ct = encryptField("tamper-me", KEY);
    const parts = ct.split(":");
    parts[3] = flipFirstByte(parts[3]!);
    expect(() => decryptField(parts.join(":"), KEY)).toThrow();
  });

  it("throws on a tampered auth tag", () => {
    const ct = encryptField("tag-tamper", KEY);
    const parts = ct.split(":");
    parts[2] = flipFirstByte(parts[2]!);
    expect(() => decryptField(parts.join(":"), KEY)).toThrow();
  });

  it("throws when decrypting with the wrong key", () => {
    const ct = encryptField("wrong-key-case", KEY);
    expect(() => decryptField(ct, OTHER_KEY)).toThrow();
  });

  it("throws on a malformed / unsupported-version string", () => {
    expect(() => decryptField("not-a-ciphertext", KEY)).toThrow();
    expect(() => decryptField("v2:aaa:bbb:ccc", KEY)).toThrow();
  });
});
