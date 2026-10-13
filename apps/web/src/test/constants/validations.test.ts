import { describe, it, expect } from "vitest";
import validations, { isIban } from "@/constants/validations";

type Rule = (v: unknown) => boolean | string;
/** Runs a rule list the way Vuetify does: first failing message, else true. */
const run = (rules: Rule[], v: unknown): boolean | string => {
  for (const r of rules) {
    const res = r(v);
    if (res !== true) return res;
  }
  return true;
};
const ok = (rules: Rule[], v: unknown): boolean => run(rules, v) === true;

describe("host", () => {
  it.each(["smtps.pec.aruba.it", "imaps.pec.example.it", "localhost", "10.0.0.1", "mail-1.example.com"])("accepts %s", (h) => {
    expect(ok(validations.host, h)).toBe(true);
    expect(ok(validations.required.host, h)).toBe(true);
  });
  it.each(["https://smtp.example.it", "smtp.example.it/path", "smtp example.it", "smtp.example.it:465", "-bad.example.it", "a..b"])("rejects %s", (h) => {
    expect(ok(validations.host, h)).toBe(false);
    expect(run(validations.host, h)).toBe("Enter a valid host name (e.g. smtps.pec.example.it), without http:// or spaces");
  });
  it("optional accepts empty, required does not", () => {
    expect(ok(validations.host, "")).toBe(true);
    expect(ok(validations.required.host, "")).toBe(false);
    expect(ok(validations.required.host, "   ")).toBe(false);
  });
});

describe("port", () => {
  it.each([1, 25, 465, "993", 65535])("accepts %s", (p) => expect(ok(validations.required.port, p)).toBe(true));
  it.each([0, 65536, -1, 1.5, "abc", "12a"])("rejects %s", (p) => expect(ok(validations.required.port, p)).toBe(false));
  it("required rejects empty/null, optional accepts", () => {
    expect(ok(validations.required.port, "")).toBe(false);
    expect(ok(validations.required.port, null)).toBe(false);
    expect(ok(validations.port, "")).toBe(true);
  });
});

describe("iban", () => {
  it("accepts valid IBANs regardless of spaces/case", () => {
    expect(ok(validations.iban, "IT60X0542811101000000123456")).toBe(true);
    expect(ok(validations.iban, "it60 x054 2811 1010 0000 0123 456")).toBe(true);
    expect(ok(validations.iban, "DE89370400440532013000")).toBe(true);
    expect(isIban("GB82 WEST 1234 5698 7654 32")).toBe(true);
  });
  it("is optional", () => {
    expect(ok(validations.iban, "")).toBe(true);
    expect(ok(validations.iban, null)).toBe(true);
    expect(ok(validations.required.iban, "")).toBe(false);
  });
  it("rejects malformed or bad-checksum IBANs", () => {
    expect(ok(validations.iban, "IT60X0542811101000000123457")).toBe(false);
    expect(ok(validations.iban, "12345")).toBe(false);
    expect(ok(validations.iban, "IT60-X054")).toBe(false);
  });
});

describe("decimal2", () => {
  it.each(["77.47", "2.00", "0", "10", "5.5"])("accepts %s", (v) => expect(ok(validations.required.decimal2, v)).toBe(true));
  it.each(["1.234", "-1", "1,5", "abc", ".5", ""])("rejects %s", (v) => expect(ok(validations.required.decimal2, v)).toBe(false));
  it("optional accepts empty", () => expect(ok(validations.decimal2, "")).toBe(true));
});

describe("intBetween / recipientCode / email / maxLength", () => {
  it("send deadline 1..60", () => {
    const r = validations.required.intBetween(1, 60);
    expect(ok(r, 12)).toBe(true);
    expect(ok(r, 60)).toBe(true);
    expect(ok(r, 0)).toBe(false);
    expect(ok(r, 61)).toBe(false);
    expect(ok(r, "")).toBe(false);
    expect(ok(r, null)).toBe(false);
  });
  it("SDI recipient code is 6-7 alphanumerics, optional", () => {
    expect(ok(validations.recipientCode, "")).toBe(true);
    expect(ok(validations.recipientCode, "M5UXCR1")).toBe(true);
    expect(ok(validations.recipientCode, "ABC123")).toBe(true);
    expect(ok(validations.recipientCode, "ABC12")).toBe(false);
    expect(ok(validations.recipientCode, "ABCDEFGH")).toBe(false);
    expect(ok(validations.recipientCode, "ABC-123")).toBe(false);
    expect(ok(validations.required.recipientCode, "")).toBe(false);
  });
  it("required.any rejects blank/whitespace, accepts 0", () => {
    expect(ok(validations.required.any, "  ")).toBe(false);
    expect(ok(validations.required.any, "")).toBe(false);
    expect(ok(validations.required.any, "x")).toBe(true);
    expect(ok(validations.required.any, 0)).toBe(true);
  });
  it("email: invalid rejected, valid accepted", () => {
    expect(ok(validations.required.email, "me@example.com")).toBe(true);
    expect(ok(validations.required.email, "me@example")).toBe(false);
    expect(ok(validations.required.email, "")).toBe(false);
    expect(ok(validations.email, "")).toBe(true);
    expect(ok(validations.email, "bad")).toBe(false);
  });
  it("required.maxLength(8) for the credit-note prefix; maxLength(100) optional", () => {
    expect(ok([validations.required.maxLength(8)], "NC")).toBe(true);
    expect(ok([validations.required.maxLength(8)], "")).toBe(false);
    expect(ok([validations.required.maxLength(8)], "TOOLONGPREFIX")).toBe(false);
    expect(ok([validations.maxLength(100)], "x".repeat(101))).toBe(false);
    expect(ok([validations.maxLength(100)], "")).toBe(true);
  });
});

describe("serviceUrl (internal service addresses)", () => {
  it("accepts container names, localhost and public hosts, with optional port/path", async () => {
    const { isServiceUrl } = await import("@/constants/validations");
    for (const ok of ["http://passo-api:3000", "http://localhost:53000", "https://passo.example.com", "http://127.0.0.1:3000/x", "http://my_service:80"]) {
      expect(isServiceUrl(ok), ok).toBe(true);
    }
    for (const bad of ["passo-api:3000", "ftp://x", "http://", "http://bad host", "http://x:99999999", ""]) {
      expect(isServiceUrl(bad), bad).toBe(false);
    }
  });
});
