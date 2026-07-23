import type { RateLimiter } from "@/modules/public-links/types.js";

/**
 * Strict per-key rate limiting for the public surface.
 *
 * The canonical design uses a Redis-backed limiter (`koa-ratelimit`) plus an edge
 * limit at the reverse proxy. This is a simple in-memory fixed-window limiter,
 * kept behind the injectable {@link RateLimiter} interface so production can swap
 * the Redis implementation and tests can inject a deterministic fake.
 *
 * The key is `${token}:${ip}` (per-token AND per-IP), so a single leaked token
 * scanned from one host is bounded, and a host scanning many tokens is bounded
 * per token. Low ceilings by design; on exceed the caller emits `429 RATE_LIMITED`
 * with a `Retry-After`.
 */
export interface InMemoryRateLimiterOptions {
  /** Max requests allowed per window per key. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

interface WindowState {
  count: number;
  resetAt: number;
}

export const createInMemoryRateLimiter = (opts: InMemoryRateLimiterOptions): RateLimiter => {
  const { max, windowMs } = opts;
  const now = opts.now ?? (() => Date.now());
  const windows = new Map<string, WindowState>();

  return {
    check(key: string): { retryAfterSeconds: number } | null {
      const t = now();
      const existing = windows.get(key);
      if (!existing || t >= existing.resetAt) {
        windows.set(key, { count: 1, resetAt: t + windowMs });
        return null;
      }
      if (existing.count < max) {
        existing.count += 1;
        return null;
      }
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - t) / 1000));
      return { retryAfterSeconds };
    },
  };
};

/** Default ceiling for the public surface: 30 requests / minute / (token+IP). */
export const DEFAULT_PUBLIC_RATE_LIMIT: InMemoryRateLimiterOptions = {
  max: 30,
  windowMs: 60_000,
};
