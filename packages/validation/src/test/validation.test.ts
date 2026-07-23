import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  Money,
  DateOnly,
  ObjectIdString,
  Email,
  Address,
  BaseDocSchema,
  safeValidate,
  dueOnOrAfterIssue,
  expiryOnOrAfterIssue,
  endOnOrAfterStart,
  isPositiveAmount,
  isNonNegativeDuration,
} from "../index.js";

describe("primitives", () => {
  it("Money accepts integer minor units incl. negative, rejects float/string", () => {
    expect(Money.safeParse(1000).success).toBe(true);
    expect(Money.safeParse(-500).success).toBe(true);
    expect(Money.safeParse(9.99).success).toBe(false);
    expect(Money.safeParse("100").success).toBe(false);
  });
  it("ObjectIdString requires 24 hex chars", () => {
    expect(ObjectIdString.safeParse("a".repeat(24)).success).toBe(true);
    expect(ObjectIdString.safeParse("xyz").success).toBe(false);
  });
  it("Email normalizes to lowercase", () => {
    expect(Email.parse("Foo@Bar.COM")).toBe("foo@bar.com");
  });
  it("DateOnly enforces YYYY-MM-DD", () => {
    expect(DateOnly.safeParse("2026-07-16").success).toBe(true);
    expect(DateOnly.safeParse("16/07/2026").success).toBe(false);
  });
  it("Address requires core fields + ISO country", () => {
    expect(Address.safeParse({ line1: "1 St", city: "Rome", postalCode: "00100", country: "IT" }).success).toBe(true);
    expect(Address.safeParse({ line1: "1 St", city: "Rome", postalCode: "00100", country: "Italy" }).success).toBe(false);
  });
});

describe("cross-field refinements (§37)", () => {
  it("dueOnOrAfterIssue", () => {
    expect(dueOnOrAfterIssue("2026-01-01", "2026-01-31")).toBe(true);
    expect(dueOnOrAfterIssue("2026-02-01", "2026-01-31")).toBe(false);
  });
  it("expiryOnOrAfterIssue", () => {
    expect(expiryOnOrAfterIssue("2026-01-01", "2026-01-01")).toBe(true);
    expect(expiryOnOrAfterIssue("2026-01-02", "2026-01-01")).toBe(false);
  });
  it("endOnOrAfterStart allows null end", () => {
    expect(endOnOrAfterStart("2026-01-01", null)).toBe(true);
    expect(endOnOrAfterStart("2026-01-01", "2025-12-31")).toBe(false);
  });
  it("isPositiveAmount / isNonNegativeDuration", () => {
    expect(isPositiveAmount(1)).toBe(true);
    expect(isPositiveAmount(0)).toBe(false);
    expect(isNonNegativeDuration(0)).toBe(true);
    expect(isNonNegativeDuration(-1)).toBe(false);
  });
});

describe("safeValidate + BaseDocSchema", () => {
  const schema = z.object({ name: z.string().min(1, { message: "field.required" }) });
  it("returns ok with the parsed value", () => {
    const r = safeValidate(schema, { name: "Acme" });
    expect(r).toEqual({ ok: true, value: { name: "Acme" } });
  });
  it("returns a field→messageKey details map on failure", () => {
    const r = safeValidate(schema, { name: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.details.name).toBe("field.required");
  });
  it("BaseDocSchema validates a persisted doc shape", () => {
    const ok = BaseDocSchema.safeParse({
      id: "a".repeat(24),
      version: 1,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      deletedAt: null,
    });
    expect(ok.success).toBe(true);
  });
});
