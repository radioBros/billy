import { hash, verify } from "@node-rs/argon2";

/**
 * Password hashing. Argon2id (the library default) with sensible cost params.
 * `verifyPassword` never throws (a malformed hash → false), and a dummy verify
 * is exposed so the login path can run constant-ish time on an unknown email
 * (username-enumeration defense).
 */
const OPTIONS = {
  // algorithm defaults to Argon2id in @node-rs/argon2 (avoid the const-enum import under isolatedModules).
  memoryCost: 19456, // 19 MiB (OWASP argon2id baseline)
  timeCost: 2,
  parallelism: 1,
} as const;

export const hashPassword = (plain: string): Promise<string> => {
  return hash(plain, OPTIONS);
};

export const verifyPassword = async (hashStr: string, plain: string): Promise<boolean> => {
  try {
    return await verify(hashStr, plain, OPTIONS);
  } catch {
    return false;
  }
};

// Precomputed once; used to spend comparable time when the email is unknown.
let dummyHash: Promise<string> | null = null;
export const dummyVerify = async (plain: string): Promise<false> => {
  dummyHash ??= hashPassword("enumeration-defense-dummy-password");
  await verifyPassword(await dummyHash, plain);
  return false;
};
