/**
 * Time-entry live timer store (time-tracking follow-up D). Drives a small
 * app-wide overlay with Start / Pause / Stop controls. The timer SURVIVES route
 * navigation (it lives in this pinia store, not in a page component) and PERSISTS
 * to localStorage so a full page refresh keeps a running timer ticking.
 *
 * Persistence model — we never store a mutable "elapsed" counter (that would
 * drift or freeze across a refresh). Instead we persist:
 *   • accumulatedMs — completed run time from segments before the latest pause
 *   • startedAt     — absolute epoch ms when the CURRENT running segment began
 *                     (null while paused/idle)
 *   • running       — whether a segment is currently counting
 * Elapsed at any instant = accumulatedMs + (running ? Date.now() - startedAt : 0).
 * Because startedAt is an absolute timestamp, a refresh recomputes the correct
 * elapsed time from the wall clock. A 1s ticker only forces the reactive display
 * to update; it is not the source of truth.
 */
import { defineStore } from "pinia";
import { ref, computed, onScopeDispose } from "vue";

const STORAGE_KEY = "billy.timer";

interface PersistedTimer {
  running: boolean;
  startedAt: number | null;
  accumulatedMs: number;
  active: boolean;
}

const readStored = (): PersistedTimer | null => {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedTimer>;
    if (typeof parsed.accumulatedMs !== "number") return null;
    return {
      running: parsed.running === true,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : null,
      accumulatedMs: parsed.accumulatedMs,
      active: parsed.active === true,
    };
  } catch {
    return null;
  }
};

export const useTimerStore = defineStore("timer", () => {
  const stored = readStored();

  /** A timer exists (running or paused) and the overlay should be shown. */
  const active = ref<boolean>(stored?.active ?? false);
  /** A segment is currently counting up. */
  const running = ref<boolean>(stored?.running ?? false);
  /** Absolute epoch ms when the current running segment began (null when paused). */
  const startedAt = ref<number | null>(stored?.startedAt ?? null);
  /** Completed run time from prior segments (before the latest pause). */
  const accumulatedMs = ref<number>(stored?.accumulatedMs ?? 0);
  /** Reactive "now" — advanced by a 1s ticker only to refresh the display. */
  const now = ref<number>(Date.now());

  function persist(): void {
    if (typeof localStorage === "undefined") return;
    const data: PersistedTimer = {
      running: running.value,
      startedAt: startedAt.value,
      accumulatedMs: accumulatedMs.value,
      active: active.value,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  /** Total elapsed milliseconds of the current timer. */
  const elapsedMs = computed<number>(() => {
    const base = accumulatedMs.value;
    if (running.value && startedAt.value !== null) {
      return base + Math.max(0, now.value - startedAt.value);
    }
    return base;
  });

  /** Whole elapsed minutes (rounded) — the value handed to the time-entry form. */
  const elapsedMinutes = computed<number>(() => Math.round(elapsedMs.value / 60000));

  /** "H:MM:SS" display string. */
  const display = computed<string>(() => {
    const totalSec = Math.floor(elapsedMs.value / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${h}:${pad(m)}:${pad(s)}`;
  });

  // 1s ticker: keeps `now` fresh so `elapsedMs`/`display` update live while a
  // segment is running. Cheap; only mutates a single ref.
  let ticker: ReturnType<typeof setInterval> | null = null;
  function startTicker(): void {
    if (ticker !== null || typeof setInterval === "undefined") return;
    ticker = setInterval(() => {
      now.value = Date.now();
    }, 1000);
  }
  function stopTicker(): void {
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  /** Begin a fresh timer (or resume from idle). Idempotent while running. */
  function start(): void {
    if (running.value) return;
    now.value = Date.now();
    startedAt.value = Date.now();
    running.value = true;
    active.value = true;
    startTicker();
    persist();
  }

  /** Hold the timer — fold the current segment into accumulatedMs. */
  function pause(): void {
    if (!running.value) return;
    if (startedAt.value !== null) {
      accumulatedMs.value += Math.max(0, Date.now() - startedAt.value);
    }
    running.value = false;
    startedAt.value = null;
    stopTicker();
    persist();
  }

  /** Resume a paused timer. */
  function resume(): void {
    if (running.value || !active.value) return;
    start();
  }

  /**
   * Finalise the timer: returns the total elapsed minutes and clears all state.
   * The caller (overlay) opens the create dialog pre-filled with this value.
   */
  function stop(): number {
    // Fold any running segment before reading the total.
    if (running.value && startedAt.value !== null) {
      accumulatedMs.value += Math.max(0, Date.now() - startedAt.value);
    }
    const minutes = Math.round(accumulatedMs.value / 60000);
    reset();
    return minutes;
  }

  /** Clear everything (used by stop + discard). */
  function reset(): void {
    running.value = false;
    startedAt.value = null;
    accumulatedMs.value = 0;
    active.value = false;
    now.value = Date.now();
    stopTicker();
    persist();
  }

  // On store creation, if a running timer was persisted (e.g. after a refresh),
  // resume the display ticker so it keeps counting from the stored startedAt.
  if (running.value && startedAt.value !== null) {
    now.value = Date.now();
    startTicker();
  }

  onScopeDispose(() => stopTicker());

  return {
    // state
    active,
    running,
    startedAt,
    accumulatedMs,
    // getters
    elapsedMs,
    elapsedMinutes,
    display,
    // actions
    start,
    pause,
    resume,
    stop,
    reset,
  };
});
