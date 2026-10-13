import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Field encryption for the PASSO credentials stored in the `einvoicing` settings. Format-
 * compatible with `apps/api/src/platform/crypto.ts` (`v1:<iv>:<tag>:<ct>`, AES-256-GCM,
 * key = sha256(DATA_ENCRYPTION_KEY), base64url) so either side can read the other's values.
 * Node-only: lives behind the package barrel, NOT the browser-safe `./codes` subpath.
 */
const deriveKey = (material: string): Buffer => {
  if (!material) throw new Error("encryption key material is empty");
  return createHash("sha256").update(material, "utf8").digest();
};

export const encryptSecret = (plaintext: string, keyMaterial: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(keyMaterial), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(":");
};

export const decryptSecret = (ciphertext: string, keyMaterial: string): string => {
  const [version, iv, tag, ct, extra] = ciphertext.split(":");
  if (version !== "v1" || !iv || !tag || ct === undefined || extra !== undefined) throw new Error("malformed ciphertext");
  const d = createDecipheriv("aes-256-gcm", deriveKey(keyMaterial), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
};
