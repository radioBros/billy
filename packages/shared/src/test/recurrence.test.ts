import { describe, it, expect } from "vitest";
import { advanceRecurrence, firstRunOnOrAfter } from "@billy/shared";

describe("advanceRecurrence — non-anchored (unchanged behavior)", () => {
  it("weekly adds 7 days", () => {
    expect(advanceRecurrence("2026-03-09", "weekly", 1)).toBe("2026-03-16");
    expect(advanceRecurrence("2026-03-09", "weekly", 2)).toBe("2026-03-23");
  });
  it("monthly/quarterly/yearly keep the source day, clamped to month length", () => {
    expect(advanceRecurrence("2026-01-15", "monthly", 1)).toBe("2026-02-15");
    expect(advanceRecurrence("2026-01-31", "monthly", 1)).toBe("2026-02-28"); // clamp
    expect(advanceRecurrence("2026-01-10", "quarterly", 1)).toBe("2026-04-10");
    expect(advanceRecurrence("2026-06-30", "yearly", 1)).toBe("2027-06-30");
  });
});

describe("advanceRecurrence — day-of-month anchor", () => {
  it("15th anchor advances 15 → 15 → 15", () => {
    let d = "2026-01-15";
    d = advanceRecurrence(d, "monthly", 1, 15);
    expect(d).toBe("2026-02-15");
    d = advanceRecurrence(d, "monthly", 1, 15);
    expect(d).toBe("2026-03-15");
  });
  it("1st anchor lands on the 1st every month", () => {
    expect(advanceRecurrence("2026-01-01", "monthly", 1, 1)).toBe("2026-02-01");
  });
  it("31st anchor crosses February and RECOVERS (no drift)", () => {
    // Jan 31 → Feb 28 (clamped) → Mar 31 (re-applies the stored anchor, not 28).
    let d = "2026-01-31";
    d = advanceRecurrence(d, "monthly", 1, 31);
    expect(d).toBe("2026-02-28");
    d = advanceRecurrence(d, "monthly", 1, 31);
    expect(d).toBe("2026-03-31"); // the drift-free property
  });
  it("anchor is ignored for weekly", () => {
    expect(advanceRecurrence("2026-03-09", "weekly", 1, 15)).toBe("2026-03-16");
  });
});

describe("firstRunOnOrAfter", () => {
  it("uses this month when start is on/before the anchor day", () => {
    expect(firstRunOnOrAfter("2026-03-05", 15)).toBe("2026-03-15");
    expect(firstRunOnOrAfter("2026-03-15", 15)).toBe("2026-03-15");
  });
  it("rolls to next month when start is past the anchor day", () => {
    expect(firstRunOnOrAfter("2026-03-20", 15)).toBe("2026-04-15");
  });
  it("clamps the anchor to the target month length", () => {
    expect(firstRunOnOrAfter("2026-02-01", 31)).toBe("2026-02-28");
  });
});

describe("advanceUntilOnOrAfter", () => {
  it("returns the date unchanged when already on/after the target", async () => {
    const { advanceUntilOnOrAfter } = await import("@billy/shared/recurrence");
    expect(advanceUntilOnOrAfter("2026-10-20", "2026-10-15", "monthly", 1)).toBe("2026-10-20");
    expect(advanceUntilOnOrAfter("2026-10-15", "2026-10-15", "monthly", 1)).toBe("2026-10-15");
  });

  it("skips whole steps, keeping the anchor day and the interval phase", async () => {
    const { advanceUntilOnOrAfter } = await import("@billy/shared/recurrence");
    // paused since March, resumed mid-October → next is Nov 1 (anchor 1)
    expect(advanceUntilOnOrAfter("2026-03-01", "2026-10-15", "monthly", 1, 1)).toBe("2026-11-01");
    // every 2 months from Jan 31 (anchor 31): Mar 31, May 31, Jul 31, Sep 30, Nov 30
    expect(advanceUntilOnOrAfter("2026-01-31", "2026-10-15", "monthly", 2, 31)).toBe("2026-11-30");
    // weekly keeps the weekday (Thursdays)
    expect(advanceUntilOnOrAfter("2026-10-01", "2026-10-16", "weekly", 1)).toBe("2026-10-22");
  });
});

describe("todayInTimeZone", () => {
  it("formats today in the zone and falls back to UTC on a bad zone", async () => {
    const { todayInTimeZone } = await import("@billy/shared/recurrence");
    const at = new Date("2026-12-31T23:30:00Z");
    expect(todayInTimeZone("Europe/Rome", at)).toBe("2027-01-01");
    expect(todayInTimeZone("America/New_York", at)).toBe("2026-12-31");
    expect(todayInTimeZone("Not/AZone", at)).toBe("2026-12-31");
  });
});
