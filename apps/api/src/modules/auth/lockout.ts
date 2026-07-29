/**
 * Per-account brute-force lockout logic. Pure decision
 * function over the consecutive-failure count: after `MAX_FAILS` the account is
 * temporarily locked; before that, escalating backoff. The counter resets on a
 * successful login. Responses stay uniform (`INVALID_CREDENTIALS`) — this only
 * decides timing/lock, never reveals account state.
 */

export const MAX_FAILS = 5;
export const LOCK_MS = 15 * 60 * 1000; // 15 min
export const BACKOFF_START_AFTER = 3;

export interface LockoutState {
  locked: boolean;
  /** Delay to apply before the next attempt is allowed (ms). */
  backoffMs: number;
}

export const lockoutState = (consecutiveFailures: number): LockoutState => {
  if (consecutiveFailures >= MAX_FAILS) {
    return { locked: true, backoffMs: LOCK_MS };
  }
  if (consecutiveFailures >= BACKOFF_START_AFTER) {
    // exponential: 3→1s, 4→2s
    const backoffMs = 2 ** (consecutiveFailures - BACKOFF_START_AFTER) * 1000;
    return { locked: false, backoffMs };
  }
  return { locked: false, backoffMs: 0 };
};
