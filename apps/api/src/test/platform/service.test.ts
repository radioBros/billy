import { describe, it, expect } from "vitest";
import type { AuthContext, Capabilities } from "@billy/types";
import { AppError } from "@billy/shared";
import { assertCapability, assertTransition } from "@/platform/service.js";
import { stripFinancial, stripFinancialList, canSeeFinancials } from "@/platform/serializer.js";

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  canManageSettings: false,
  canManageUsers: false,
  canPermanentlyDelete: false,
  canViewFinancialTotals: false,
  canExportData: false,
  ...over,
});

const admin: AuthContext = { userId: "a", role: "administrator", capabilities: caps(), accountId: "b" };
const member = (over: Partial<Capabilities> = {}): AuthContext => ({
  userId: "m",
  role: "member",
  capabilities: caps(over),
  accountId: "b",
});

describe("assertCapability (SRV-5)", () => {
  it("administrator bypasses all capability checks", () => {
    expect(() => assertCapability(admin, "canPermanentlyDelete")).not.toThrow();
  });
  it("member without the capability is denied (CAPABILITY_DENIED)", () => {
    try {
      assertCapability(member(), "canPermanentlyDelete");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe("CAPABILITY_DENIED");
    }
  });
  it("member with the capability passes", () => {
    expect(() => assertCapability(member({ canPermanentlyDelete: true }), "canPermanentlyDelete")).not.toThrow();
  });
});

describe("assertTransition (SRV-4)", () => {
  const allowed = { draft: ["sent"], sent: ["paid", "void"], paid: [], void: [] } as const;
  it("permits an allowed transition", () => {
    expect(() => assertTransition("draft", "sent", allowed)).not.toThrow();
  });
  it("rejects an illegal transition (INVALID_STATE_TRANSITION)", () => {
    try {
      assertTransition("draft", "paid", allowed);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as AppError).code).toBe("INVALID_STATE_TRANSITION");
    }
  });
});

describe("financial stripping (SRV-6 / SEC5)", () => {
  const doc = { id: "1", name: "Acme", grandTotal: 1000, amountDue: 400 };
  const fields = ["grandTotal", "amountDue"];

  it("keeps financial fields for an administrator", () => {
    expect(canSeeFinancials(admin)).toBe(true);
    expect(stripFinancial(admin, doc, fields)).toEqual(doc);
  });
  it("keeps them for a member with canViewFinancialTotals", () => {
    expect(stripFinancial(member({ canViewFinancialTotals: true }), doc, fields)).toEqual(doc);
  });
  it("removes them from the payload for a restricted member", () => {
    const out = stripFinancial(member(), doc, fields);
    expect(out).toEqual({ id: "1", name: "Acme" });
    expect("grandTotal" in out).toBe(false);
  });
  it("strips across a list", () => {
    const out = stripFinancialList(member(), [doc, { ...doc, id: "2" }], fields);
    expect(out.every((d) => !("grandTotal" in d))).toBe(true);
  });
});
