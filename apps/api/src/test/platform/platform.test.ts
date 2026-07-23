import { describe, it, expect } from "vitest";
import type { AuthContext, BaseDoc, ListWhitelist } from "@billy/types";
import { AppError } from "@billy/shared";
import { assertAuthContext, buildScopedFilter } from "@/platform/repository.js";
import { parseListQuery } from "@/platform/list-query.js";

const ctx: AuthContext = {
  userId: "u1",
  role: "administrator",
  capabilities: {
    canManageSettings: true,
    canManageUsers: true,
    canPermanentlyDelete: true,
    canViewFinancialTotals: true,
    canExportData: true,
  },
  accountId: "biz1",
};

const whitelist: ListWhitelist = {
  sortable: ["createdAt", "name"],
  filterable: ["status", "type"],
  searchable: ["name", "email"],
};

describe("assertAuthContext (mandatory scope guard)", () => {
  it("throws FORBIDDEN when missing", () => {
    expect(() => assertAuthContext(undefined)).toThrowError(AppError);
    try {
      assertAuthContext(undefined);
    } catch (e) {
      expect((e as AppError).code).toBe("FORBIDDEN");
    }
  });
  it("throws when accountId is empty", () => {
    expect(() => assertAuthContext({ ...ctx, accountId: "" })).toThrowError(AppError);
  });
  it("passes for a valid context", () => {
    expect(() => assertAuthContext(ctx)).not.toThrow();
  });
});

describe("buildScopedFilter", () => {
  it("always excludes soft-deleted and (by default) archived docs", () => {
    const f = buildScopedFilter<BaseDoc>(ctx, { id: "x" }) as Record<string, unknown>;
    expect(f.deletedAt).toBeNull();
    expect(f.archivedAt).toBeNull();
    expect(f.id).toBe("x");
  });
  it("ALWAYS injects the accountId scope (fail-closed — no opt-out)", () => {
    const f = buildScopedFilter<BaseDoc>(ctx, {}) as Record<string, unknown>;
    expect(f.accountId).toBe("biz1");
  });
  it("archived=all drops the archive constraint", () => {
    const f = buildScopedFilter<BaseDoc>(ctx, {}, { archived: "all" }) as Record<string, unknown>;
    expect("archivedAt" in f).toBe(false);
  });
  it("archived=true matches only archived", () => {
    const f = buildScopedFilter<BaseDoc>(ctx, {}, { archived: "true" }) as Record<string, unknown>;
    expect(f.archivedAt).toEqual({ $ne: null });
  });
});

describe("parseListQuery (list grammar)", () => {
  it("applies defaults", () => {
    const p = parseListQuery({}, whitelist);
    expect(p.page).toBe(1);
    expect(p.limit).toBe(50);
    expect(p.skip).toBe(0);
  });
  it("clamps limit to the max (200)", () => {
    expect(parseListQuery({ limit: "9999" }, whitelist).limit).toBe(200);
  });
  it("parses sort with desc prefix", () => {
    const p = parseListQuery({ sort: "-createdAt,name" }, whitelist);
    expect(p.sort).toEqual({ createdAt: -1, name: 1 });
  });
  it("rejects a non-whitelisted sort field", () => {
    expect(() => parseListQuery({ sort: "password" }, whitelist)).toThrowError(AppError);
  });
  it("rejects a non-whitelisted filter field", () => {
    expect(() => parseListQuery({ secret: "x" }, whitelist)).toThrowError(AppError);
  });
  it("parses [in] multi-value filters", () => {
    const p = parseListQuery({ "status[in]": "a,b" }, whitelist);
    expect(p.filter.status).toEqual({ $in: ["a", "b"] });
  });
  it("builds a case-insensitive q across searchable fields", () => {
    const p = parseListQuery({ q: "acme" }, whitelist);
    expect(p.filter.$or).toEqual([
      { name: { $regex: "acme", $options: "i" } },
      { email: { $regex: "acme", $options: "i" } },
    ]);
  });
});
