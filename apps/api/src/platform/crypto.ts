import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { AppError } from "@billy/shared";

/**
 * App-layer field encryption primitive. Encrypts the highest-sensitivity
 * fields at rest (e.g. the admin-set SMTP password) with AES-256-GCM.
 *
 * Design constraints:
 *  - **Deterministic key derivation.** The 32-byte AES key is derived from
 *    `keyMaterial` (the operator's `DATA_ENCRYPTION_KEY`, config/index.ts) via a
 *    single SHA-256. This is deterministic on purpose — a per-call random salt
 *    (e.g. plain scrypt) would make ciphertext undecryptable, since the salt is
 *    not stored. SHA-256 over an already-high-entropy env secret gives a uniform
 *    32-byte key without a stored salt.
 *  - **Random IV + auth tag per encryption.** A fresh 12-byte IV (GCM's native
 *    nonce size) is generated for every `encryptField` call, and GCM's auth tag
 *    is stored alongside so tamper/wrong-key is detected on decrypt.
 *  - **Versioned self-describing string.** Output is `v1:<iv>:<tag>:<ct>` with
 *    each part base64url. The `v1` prefix lets a future algorithm/format change
 *    coexist with existing ciphertext (rotation path).
 *
 * Keys never live with the ciphertext: only ciphertext is
 * stored in Mongo; `keyMaterial` comes from env/secret store. Never log either.
 */

const FORMAT_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length
const AUTH_TAG_BYTES = 16;

const deriveKey = (keyMaterial: string): Buffer => {
  if (!keyMaterial) {
    throw new AppError("INTERNAL_ERROR", "encryption key material is empty");
  }
  // SHA-256 → exactly 32 bytes, deterministic (no stored salt needed).
  return createHash("sha256").update(keyMaterial, "utf8").digest();
};

const b64url = (buf: Buffer): string => buf.toString("base64url");

export const encryptField = (plaintext: string, keyMaterial: string): string => {
  const key = deriveKey(keyMaterial);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_VERSION, b64url(iv), b64url(tag), b64url(ct)].join(":");
};

export const decryptField = (ciphertext: string, keyMaterial: string): string => {
  const parts = ciphertext.split(":");
  const [version, ivB64, tagB64, ctB64] = parts;
  if (parts.length !== 4 || version !== FORMAT_VERSION || !ivB64 || !tagB64 || ctB64 === undefined) {
    throw new AppError("INTERNAL_ERROR", "malformed or unsupported ciphertext");
  }
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const ct = Buffer.from(ctB64, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES) {
    throw new AppError("INTERNAL_ERROR", "malformed ciphertext segments");
  }
  const key = deriveKey(keyMaterial);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    // GCM tag mismatch (tamper or wrong key) surfaces here as a thrown error.
    throw new AppError("INTERNAL_ERROR", "authentication failed");
  }
};
