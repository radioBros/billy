import { describe, it, expect } from "vitest";
import { createLogger } from "@billy/shared";
import type { AuthContext } from "@billy/types";
import { todayInZone, addDaysIso } from "@billy/einvoice";
import { computeLine } from "@/platform/money.js";
import { createProformaRouter } from "@/modules/proforma/routes.js";
import { driveRouter, fakeCtx, fakeMongo, type Doc } from "@/test/fake-mongo.js";

/**
 * Router-level: POST /api/v1/proformas/:id/convert mints the draft invoice through
 * the REAL InvoiceService wiring — dates, fields, and the proforma's chosen bank.
 */

const logger = createLogger({ level: "silent", pretty: false, service: "test" });

const ADMIN: AuthContext = {
  userId: "u-admin",
  role: "administrator",
  capabilities: {
    canManageSettings: true,
    canManageUsers: true,
    canPermanentlyDelete: true,
    canViewFinancialTotals: true,
    canExportData: true,
  },
  accountId: "acc-1",
};

const PRO_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const CLIENT_ID = "cccccccccccccccccccccccc";
const TZ = "Pacific/Kiritimati"; // UTC+14 — "today" differs from UTC most of the day

const BANKS = [
  { id: "bank-a", label: "Main", details: "Bank A\nIBAN IT00A", iban: "IT00A" },
  { id: "bank-b", label: "Second", details: "Bank B\nIBAN IT00B", iban: "IT00B" },
];

const issuedProforma = (overrides: Doc = {}): Doc => ({
  id: PRO_ID,
  accountId: "acc-1",
  version: 2,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  clientId: CLIENT_ID,
  projectId: "dddddddddddddddddddddddd",
  clientSnapshot: { clientId: CLIENT_ID, displayName: "Acme", currency: "EUR" },
  proformaNumber: "PRO/1/2026",
  currency: "EUR",
  bankSnapshot: { label: "Second", details: "Bank B\nIBAN IT00B" },
  issueDate: "2026-03-01",
  expiryDate: "2026-03-31", // 30-day gap
  subject: "Q2 retainer",
  lineItems: [computeLine({ description: "Exempt", quantity: 1, unitPriceMinor: 1000, taxRate: 0, nature: "N2.2" })],
  subtotalMinor: 1000,
  discountMinor: 0,
  taxMinor: 0,
  grandTotalMinor: 1000,
  status: "issued",
  convertedInvoiceId: null,
  convertingAt: null,
  notes: "Paid in advance",
  ...overrides,
});

const setup = (proforma: Doc = issuedProforma()) => {
  const mongo = fakeMongo({
    proformas: [proforma],
    settings: [{ key: "business", accountId: "acc-1", data: { businessName: "Billy", timezone: TZ, bankAccounts: BANKS } }],
    clients: [{ id: CLIENT_ID, accountId: "other-account", displayName: "Someone else's client", deletedAt: null }],
  });
  const router = createProformaRouter({ db: mongo.db, emitter: { emit: () => undefined }, logger });
  return { ...mongo, drive: driveRouter(router) };
};

const ctxFor = (action: string, id: string, version: number) =>
  fakeCtx(ADMIN, { method: "POST", path: `/api/v1/proformas/${id}/${action}`, params: { id }, body: { version } });

describe("POST /api/v1/proformas/:id/convert", () => {
  it("mints a draft dated today (account tz), due after the proforma's gap, with its fields + bank", async () => {
    const { drive, col } = setup();
    const ctx = ctxFor("convert", PRO_ID, 2);
    await drive(ctx);
    expect(ctx.status).toBe(201);

    const [inv] = col("invoices").docs;
    const today = todayInZone(TZ);
    expect(inv).toMatchObject({
      status: "draft",
      issueDate: today,
      dueDate: addDaysIso(today, 30),
      subject: "Q2 retainer",
      projectId: "dddddddddddddddddddddddd",
      notes: "Paid in advance",
      // Matched back to its settings account → full snapshot incl. IBAN.
      bankSnapshot: { label: "Second", details: "Bank B\nIBAN IT00B", iban: "IT00B" },
    });
    expect((inv!.lineItems as Doc[])[0]).toMatchObject({ nature: "N2.2" });
    expect(col("proformas").docs[0]).toMatchObject({ convertedInvoiceId: inv!.id, convertingAt: null });
  });

  it("copies the frozen bank snapshot when its settings account was removed/renamed", async () => {
    const { drive, col } = setup(issuedProforma({ bankSnapshot: { label: "Old bank", details: "Closed\nIBAN IT99" } }));
    await drive(ctxFor("convert", PRO_ID, 2));
    expect(col("invoices").docs[0]!.bankSnapshot).toEqual({ label: "Old bank", details: "Closed\nIBAN IT99" });
  });

  it("is idempotent on replay: a second convert returns the same invoice", async () => {
    const { drive, col } = setup();
    await drive(ctxFor("convert", PRO_ID, 2));
    const version = col("proformas").docs[0]!.version as number;
    await drive(ctxFor("convert", PRO_ID, version));
    expect(col("invoices").docs).toHaveLength(1);
  });
});

describe("proforma client lookup is account-scoped", () => {
  it("issue never snapshots another account's client (no unscoped fallback)", async () => {
    const { drive } = setup(issuedProforma({ status: "draft", proformaNumber: null, clientSnapshot: null }));
    await expect(drive(ctxFor("issue", PRO_ID, 2))).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
});
