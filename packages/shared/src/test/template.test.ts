import { describe, it, expect } from "vitest";
import { resolvePlaceholders, formatDate, type TemplateContext } from "@billy/shared";

const ctx: TemplateContext = {
  now: "2026-03-09",
  issueDate: "2026-03-09",
  dueDate: "2026-03-16",
  expiryDate: "2026-04-08",
  document: { number: "INV-2026-0042", total: "1.234,56 EUR" },
  client: {
    name: "Acme S.r.l.",
    email: "billing@acme.example",
    vat: "IT01234567890",
    address: { line1: "Via Roma 10", postalCode: "20100", city: "Milano", country: "IT" },
  },
  company: {
    name: "Billy Ltd",
    vat: "GB999999973",
    address: { line1: "1 High St", postalCode: "EC1A 1BB", city: "London", country: "GB" },
  },
  locale: "en",
};

describe("formatDate", () => {
  it("formats with dd MMM YYYY tokens", () => {
    expect(formatDate("2026-03-09", "dd MMM YYYY", "en")).toBe("09 Mar 2026");
  });
  it("supports full month + day/month/year variants", () => {
    expect(formatDate("2026-03-09", "D MMMM YYYY", "en")).toBe("9 March 2026");
    expect(formatDate("2026-03-09", "DD/MM/YY", "en")).toBe("09/03/26");
  });
  it("localizes month names", () => {
    expect(formatDate("2026-03-09", "MMMM", "it")).toBe("marzo");
    expect(formatDate("2026-03-09", "MMM", "de")).toMatch(/M(ä|a)r/);
  });
  it("emits quoted literals verbatim", () => {
    expect(formatDate("2026-03-09", "'Issued on' DD.MM.YYYY", "en")).toBe("Issued on 09.03.2026");
  });
  it("returns '' for empty and the raw value for unparseable input", () => {
    expect(formatDate(null, "YYYY", "en")).toBe("");
    expect(formatDate("not-a-date", "YYYY", "en")).toBe("not-a-date");
  });
});

describe("resolvePlaceholders", () => {
  it("resolves {{date}} to the default format from `now`", () => {
    expect(resolvePlaceholders("Date: {{date}}", ctx)).toBe("Date: 2026-03-09");
  });
  it("resolves {{date|\"fmt\"}} with an explicit format", () => {
    expect(resolvePlaceholders('Le {{date|"dd MMM YYYY"}}', ctx)).toBe("Le 09 Mar 2026");
  });
  it("resolves document + client + company tokens", () => {
    expect(resolvePlaceholders("{{document.number}}", ctx)).toBe("INV-2026-0042");
    expect(resolvePlaceholders("{{client.name}}", ctx)).toBe("Acme S.r.l.");
    expect(resolvePlaceholders("{{client.vat}}", ctx)).toBe("IT01234567890");
    expect(resolvePlaceholders("{{company.name}}", ctx)).toBe("Billy Ltd");
    expect(resolvePlaceholders("{{total}}", ctx)).toBe("1.234,56 EUR");
  });
  it("formats one-line addresses", () => {
    expect(resolvePlaceholders("{{client.address}}", ctx)).toBe("Via Roma 10, 20100, Milano, IT");
  });
  it("resolves issue/due/expiry dates with the default format", () => {
    expect(resolvePlaceholders("{{issueDate}} / {{dueDate}} / {{expiryDate}}", ctx)).toBe(
      "2026-03-09 / 2026-03-16 / 2026-04-08",
    );
  });
  it("honors defaultDateFormat for bare date tokens", () => {
    expect(resolvePlaceholders("{{issueDate}}", { ...ctx, defaultDateFormat: "dd/MM/YYYY" })).toBe(
      "09/03/2026",
    );
  });
  it("leaves UNKNOWN tokens verbatim (no injection/field leak)", () => {
    expect(resolvePlaceholders("{{client.password}} {{foo.bar}} {{}}", ctx)).toBe(
      "{{client.password}} {{foo.bar}} {{}}",
    );
  });
  it("renders missing values as empty string, not 'undefined'", () => {
    expect(resolvePlaceholders("[{{client.name}}]", { locale: "en" })).toBe("[]");
  });
  it("returns '' for null/undefined text", () => {
    expect(resolvePlaceholders(null, ctx)).toBe("");
    expect(resolvePlaceholders(undefined, ctx)).toBe("");
  });
  it("resolves multiple placeholders in one string, mixed known/unknown", () => {
    const tpl = "Invoice {{document.number}} for {{client.name}} — pay by {{dueDate}} ({{mystery}})";
    expect(resolvePlaceholders(tpl, ctx)).toBe(
      "Invoice INV-2026-0042 for Acme S.r.l. — pay by 2026-03-16 ({{mystery}})",
    );
  });
  it("tolerates whitespace inside the braces", () => {
    expect(resolvePlaceholders("{{  client.name  }}", ctx)).toBe("Acme S.r.l.");
  });
});

describe("resolvePlaceholders — {{date}} month offsets", () => {
  it("shifts back N months and formats (last-month name)", () => {
    // Anchor 2026-03-09 → -1 month = February.
    expect(resolvePlaceholders('{{date -1|"MMMM"}}', ctx)).toBe("February");
    expect(resolvePlaceholders('{{date -1|"MMMM"}}', { ...ctx, locale: "it" })).toBe("febbraio");
    expect(resolvePlaceholders('{{date -2|"MM/YYYY"}}', ctx)).toBe("01/2026");
  });
  it("shifts forward with a positive offset", () => {
    expect(resolvePlaceholders('{{date +1|"MMMM YYYY"}}', ctx)).toBe("April 2026");
  });
  it("clamps the day to the target month's last valid day (no spill)", () => {
    const c = { ...ctx, now: "2026-03-31", issueDate: "2026-03-31" };
    // -1 from Mar 31 must be Feb 28 (2026 non-leap), NOT spill into March.
    expect(resolvePlaceholders('{{date -1|"YYYY-MM-DD"}}', c)).toBe("2026-02-28");
  });
  it("crosses the year boundary correctly", () => {
    const c = { ...ctx, now: "2026-01-31", issueDate: "2026-01-31" };
    // -1 from Jan 31 = Dec 2025 (31 valid).
    expect(resolvePlaceholders('{{date -1|"YYYY-MM-DD"}}', c)).toBe("2025-12-31");
    expect(resolvePlaceholders('{{date -1|"MMMM YYYY"}}', c)).toBe("December 2025");
  });
  it("offset with no format uses the default date format", () => {
    expect(resolvePlaceholders("{{date -1}}", ctx)).toBe("2026-02-09");
  });
  it("a month offset on a FIXED date token is not a registered form → left verbatim", () => {
    expect(resolvePlaceholders("{{issueDate -1}}", ctx)).toBe("{{issueDate -1}}");
  });
  it("plain {{date}} (no offset) is unaffected", () => {
    expect(resolvePlaceholders("{{date}}", ctx)).toBe("2026-03-09");
  });
});
