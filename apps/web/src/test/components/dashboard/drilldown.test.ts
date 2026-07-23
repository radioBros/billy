import { describe, it, expect } from "vitest";
import { buildDrilldownQuery, lastDayOfMonth } from "@/components/dashboard/types";

describe("buildDrilldownQuery", () => {
  it("builds a single-month range on the type's date field + reconciling status filter (invoices)", () => {
    const q = buildDrilldownQuery("invoices", 2026, [3]);
    expect(q["issueDate[gte]"]).toBe("2026-03-01");
    expect(q["issueDate[lte]"]).toBe("2026-03-31");
    // Matches the counts chart's ISSUED_STATUSES exactly — NOT "sent"/"draft".
    expect(q["status[in]"]).toBe("finalized,partially_paid,paid,overdue");
  });

  it("unions multiple months into a min..max range (may include middle months)", () => {
    const q = buildDrilldownQuery("quotes", 2026, [2, 5]);
    expect(q["issueDate[gte]"]).toBe("2026-02-01");
    expect(q["issueDate[lte]"]).toBe("2026-05-31");
    // Quotes exclude draft.
    expect(q["status[in]"]).toBe("sent,accepted,declined,expired,converted");
  });

  it("NONE selected = the whole year (Jan 1 .. Dec 31)", () => {
    const q = buildDrilldownQuery("creditNotes", 2025, []);
    expect(q["issueDate[gte]"]).toBe("2025-01-01");
    expect(q["issueDate[lte]"]).toBe("2025-12-31");
    expect(q["status[in]"]).toBe("issued,void");
  });

  it("contracts bucket by startDate with NO status filter", () => {
    const q = buildDrilldownQuery("contracts", 2026, [6]);
    expect(q["startDate[gte]"]).toBe("2026-06-01");
    expect(q["startDate[lte]"]).toBe("2026-06-30");
    expect(q["status[in]"]).toBeUndefined();
  });

  it("expenses bucket by date with NO status filter", () => {
    const q = buildDrilldownQuery("expenses", 2026, [12]);
    expect(q["date[gte]"]).toBe("2026-12-01");
    expect(q["date[lte]"]).toBe("2026-12-31");
    expect(q["status[in]"]).toBeUndefined();
  });

  it("handles February leap vs non-leap last day", () => {
    expect(lastDayOfMonth(2024, 2)).toBe(29); // leap
    expect(lastDayOfMonth(2026, 2)).toBe(28); // non-leap
    expect(buildDrilldownQuery("invoices", 2024, [2])["issueDate[lte]"]).toBe("2024-02-29");
  });
});
