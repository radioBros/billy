import { describe, it, expect } from "vitest";
import type { Db } from "mongodb";
import { createLogger, AppError } from "@billy/shared";
import type { AuthContext, Capabilities } from "@billy/types";
import type { DomainEvent, DomainEventEmitter } from "@/platform/service.js";
import { ExportService, EXPORT_COLLECTIONS, isExportResource, toCsv } from "@/modules/import-export/service.js";
import { createImportExportRouter } from "@/modules/import-export/routes.js";

const logger = createLogger({ level: "silent", pretty: false, service: "test" });

const newEmitter = (): { emitter: DomainEventEmitter; events: DomainEvent[] } => {
  const events: DomainEvent[] = [];
  return { emitter: { emit: (e) => void events.push(e) }, events };
};

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  canManageSettings: false,
  canManageUsers: false,
  canPermanentlyDelete: false,
  canViewFinancialTotals: false,
  canExportData: false,
  ...over,
});

const ADMIN: AuthContext = { userId: "u-admin", role: "administrator", capabilities: caps(), accountId: "default" };
const member = (over: Partial<Capabilities> = {}): AuthContext => ({
  userId: "u-member",
  role: "member",
  capabilities: caps(over),
  accountId: "default",
});

// ── toCsv — RFC-4180 quoting/escaping ────────────────────────────────────────

describe("toCsv (RFC-4180)", () => {
  it("quotes fields containing commas, quotes, and newlines; escapes quotes by doubling", () => {
    const csv = toCsv([{ a: "plain", b: "has,comma", c: 'he said "hi"', d: "line1\nline2" }]);
    const [header, row] = csv.split("\r\n");
    expect(header).toBe("a,b,c,d");
    // comma → quoted; quote → doubled + quoted; newline → quoted (verbatim inside)
    expect(row).toBe('plain,"has,comma","he said ""hi""","line1\nline2"');
  });

  it("handles a field containing comma AND quote AND newline together", () => {
    const csv = toCsv([{ x: 'a,b "c"\nd' }]);
    expect(csv).toBe('x\r\n"a,b ""c""\nd"');
  });

  it("terminates records with CRLF", () => {
    const csv = toCsv([{ a: "1" }, { a: "2" }]);
    expect(csv).toBe("a\r\n1\r\n2");
  });

  it("header is the union of keys in first-seen order across rows", () => {
    const csv = toCsv([{ a: 1, b: 2 }, { b: 3, c: 4 }]);
    expect(csv.split("\r\n")[0]).toBe("a,b,c");
  });

  it("renders nullish as empty and objects/arrays as JSON", () => {
    const csv = toCsv([{ n: null, u: undefined, tags: ["x", "y"], addr: { city: "Rome" } }]);
    const [, row] = csv.split("\r\n");
    // tags contains a comma inside the JSON → quoted; addr JSON has quotes → quoted+doubled
    expect(row).toBe(',,"[""x"",""y""]","{""city"":""Rome""}"');
  });
});

// ── resource whitelist ───────────────────────────────────────────────────────

describe("export resource whitelist", () => {
  it("accepts the whitelisted resources", () => {
    for (const r of ["clients", "expenses", "contracts", "time-entries", "subscriptions", "quotes", "invoices"]) {
      expect(isExportResource(r)).toBe(true);
    }
  });

  it("rejects unknown and sensitive resources (users/sessions absent by design)", () => {
    for (const r of ["users", "sessions", "passwords", "unknown", "__proto__", ""]) {
      expect(isExportResource(r)).toBe(false);
    }
  });

  it("never maps a whitelisted resource to an identity/credential collection", () => {
    const collections = Object.values(EXPORT_COLLECTIONS);
    expect(collections).not.toContain("users");
    expect(collections).not.toContain("sessions");
  });
});

// ── capability gate + whitelist enforcement in ExportService.export ──────────

describe("ExportService.export — guards run before any db access", () => {
  it("denies a member without canExportData (CAPABILITY_DENIED), never touching db", async () => {
    const { emitter, events } = newEmitter();
    // `{} as Db` — a thrown guard must never reach it.
    const svc = new ExportService({ db: {} as Db, emitter, logger });
    await expect(svc.export(member(), "clients", "csv")).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    expect(events).toHaveLength(0);
  });

  it("allows a member WITH canExportData past the capability gate", async () => {
    const { db, captured } = fakeDb({ clients: [{ id: "c1", deletedAt: null, displayName: "Acme" }] });
    const { emitter } = newEmitter();
    const svc = new ExportService({ db, emitter, logger });
    await expect(svc.export(member({ canExportData: true }), "clients", "json")).resolves.toBeDefined();
    expect(captured.filter?.deletedAt).toBe(null);
  });

  it("rejects an unknown/sensitive resource with VALIDATION_FAILED (admin bypasses cap)", async () => {
    const svc = new ExportService({ db: {} as Db, emitter: newEmitter().emitter, logger });
    await expect(svc.export(ADMIN, "users", "csv")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(svc.export(ADMIN, "unknown", "json")).rejects.toBeInstanceOf(AppError);
  });
});

// ── scoping + redaction (happy path with a capturing fake db) ────────────────

describe("ExportService.export — scoping + redaction", () => {
  it("scopes reads with deletedAt:null and strips _id + secret fields", async () => {
    const { db, captured } = fakeDb({
      clients: [{ _id: "objid", id: "c1", deletedAt: null, displayName: "Acme", passwordHash: "leak", tags: ["a"] }],
    });
    const { emitter, events } = newEmitter();
    const svc = new ExportService({ db, emitter, logger });

    const result = await svc.export(ADMIN, "clients", "json");

    expect(captured.collectionName).toBe("clients");
    // Export is now account-scoped (fail-closed): the read filter includes accountId.
    expect(captured.filter).toEqual({ deletedAt: null, accountId: "default" });

    const rows = JSON.parse(result.body) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("_id");
    expect(rows[0]).not.toHaveProperty("passwordHash");
    expect(rows[0]).toMatchObject({ id: "c1", displayName: "Acme" });

    expect(result.contentType).toContain("application/json");
    expect(result.filename).toMatch(/^clients-\d{4}-\d{2}-\d{2}\.json$/u);
    expect(result.count).toBe(1);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: "export.performed", entityId: "clients", actorId: "u-admin" });
  });

  it("produces CSV with the csv content-type and extension", async () => {
    const { db } = fakeDb({ expenses: [{ id: "e1", deletedAt: null, amountMinor: 5000 }] });
    const svc = new ExportService({ db, emitter: newEmitter().emitter, logger });
    const result = await svc.export(ADMIN, "expenses", "csv");
    expect(result.contentType).toContain("text/csv");
    expect(result.filename).toMatch(/\.csv$/u);
    expect(result.body.split("\r\n")[0]).toBe("id,deletedAt,amountMinor");
  });
});

// ── router wiring (transpiles + constructs routes.ts) ────────────────────────

describe("createImportExportRouter", () => {
  it("builds a router without throwing", () => {
    const { db } = fakeDb({});
    const r = createImportExportRouter({ db, emitter: newEmitter().emitter, logger });
    expect(typeof r.routes).toBe("function");
    expect(typeof r.allowedMethods).toBe("function");
  });
});

const fakeDb = (data: Record<string, Record<string, unknown>[]>): {
  db: Db;
  captured: { collectionName?: string; filter?: Record<string, unknown> };
} => {
  const captured: { collectionName?: string; filter?: Record<string, unknown> } = {};
  const db = {
    collection(name: string) {
      captured.collectionName = name;
      return {
        find(filter: Record<string, unknown>) {
          captured.filter = filter;
          return { toArray: async () => data[name] ?? [] };
        },
      };
    },
  } as unknown as Db;
  return { db, captured };
};
