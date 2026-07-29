import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useTimerStore } from "@/stores/timer";

const STORAGE_KEY = "billy.timer";

describe("timer store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T10:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts idle/inactive", () => {
    const timer = useTimerStore();
    expect(timer.active).toBe(false);
    expect(timer.running).toBe(false);
    expect(timer.elapsedMs).toBe(0);
    expect(timer.elapsedMinutes).toBe(0);
  });

  it("start begins counting and marks active", () => {
    const timer = useTimerStore();
    timer.start();
    expect(timer.active).toBe(true);
    expect(timer.running).toBe(true);
    // advance 90s of wall clock + ticker
    vi.advanceTimersByTime(90_000);
    expect(timer.elapsedMs).toBe(90_000);
    expect(timer.display).toBe("0:01:30");
  });

  it("pause folds the current segment and holds elapsed", () => {
    const timer = useTimerStore();
    timer.start();
    vi.advanceTimersByTime(60_000);
    timer.pause();
    expect(timer.running).toBe(false);
    expect(timer.active).toBe(true);
    const held = timer.elapsedMs;
    expect(held).toBe(60_000);
    // Time passes while paused — elapsed must NOT advance.
    vi.advanceTimersByTime(120_000);
    expect(timer.elapsedMs).toBe(held);
  });

  it("resume continues accumulating from the paused total", () => {
    const timer = useTimerStore();
    timer.start();
    vi.advanceTimersByTime(30_000); // 30s
    timer.pause();
    vi.advanceTimersByTime(999_999); // paused; ignored
    timer.resume();
    vi.advanceTimersByTime(30_000); // +30s
    expect(timer.elapsedMs).toBe(60_000);
  });

  it("stop returns whole elapsed minutes and clears state", () => {
    const timer = useTimerStore();
    timer.start();
    vi.advanceTimersByTime(125_000); // 2m 5s → rounds to 2
    const minutes = timer.stop();
    expect(minutes).toBe(2);
    expect(timer.active).toBe(false);
    expect(timer.running).toBe(false);
    expect(timer.elapsedMs).toBe(0);
  });

  it("persists a running timer to localStorage", () => {
    const timer = useTimerStore();
    timer.start();
    vi.advanceTimersByTime(45_000);
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.running).toBe(true);
    expect(parsed.active).toBe(true);
    expect(typeof parsed.startedAt).toBe("number");
  });

  it("restores a running timer across a fresh store (refresh) using the wall clock", () => {
    // First store starts a timer.
    const first = useTimerStore();
    first.start();
    vi.advanceTimersByTime(60_000); // 1 min elapsed and persisted

    // Simulate a page refresh: new pinia + new store instance reading storage.
    // Wall clock advances another 30s while "reloading".
    vi.advanceTimersByTime(30_000);
    setActivePinia(createPinia());
    const restored = useTimerStore();
    expect(restored.active).toBe(true);
    expect(restored.running).toBe(true);
    // 60s (before) + 30s (during reload) = 90s recomputed from startedAt.
    expect(restored.elapsedMs).toBe(90_000);
  });

  it("reset clears persisted state", () => {
    const timer = useTimerStore();
    timer.start();
    vi.advanceTimersByTime(10_000);
    timer.reset();
    expect(timer.active).toBe(false);
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(parsed.active).toBe(false);
    expect(parsed.accumulatedMs).toBe(0);
  });
});
