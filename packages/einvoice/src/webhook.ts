import { createHmac, timingSafeEqual } from "node:crypto";

export type WebhookVerdict = "ok" | "missing_header" | "malformed" | "stale" | "bad_signature";

/**
 * Verify a PASSO webhook: `x-passo-signature: t=<unix>,v1=<hex>[,v1=<old>]` where each v1 is
 * HMAC-SHA256(secret, `${t}.${rawBody}`). During secret rotation the header holds two v1
 * values; either may match. `rawBody` must be the exact bytes received.
 */
export const verifyPassoWebhook = (
  header: string | undefined,
  rawBody: string,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): WebhookVerdict => {
  if (!header) return "missing_header";
  let t: string | null = null;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") sigs.push(v);
  }
  if (!t || !/^\d+$/u.test(t) || sigs.length === 0) return "malformed";
  if (Math.abs(nowSec - Number(t)) > toleranceSec) return "stale";
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  for (const s of sigs) {
    if (!/^[0-9a-f]{64}$/iu.test(s)) continue;
    const got = Buffer.from(s, "hex");
    if (got.length === expected.length && timingSafeEqual(got, expected)) return "ok";
  }
  return "bad_signature";
};

/** Test/helper: produce a header the way PASSO does. */
export const signPassoWebhook = (rawBody: string, secret: string, t: number): string =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
