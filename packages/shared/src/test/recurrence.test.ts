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
