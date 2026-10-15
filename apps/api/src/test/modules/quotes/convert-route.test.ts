import { describe, it, expect } from "vitest";
import { createLogger } from "@billy/shared";
import type { AuthContext } from "@billy/types";
import { computeLine } from "@/platform/money.js";
import { createQuotesRouter } from "@/modules/quotes/routes.js";
import { driveRouter, fakeCtx, fakeMongo, type Doc } from "@/test/fake-mongo.js";

/**
 * Router-level: POST /api/v1/quotes/:id/convert creates the draft invoice through
 * the REAL InvoiceService.createFromQuote wiring and links it, in one request.
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

const QUOTE_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const CLIENT_ID = "cccccccccccccccccccccccc";
const PROJECT_ID = "dddddddddddddddddddddddd";

const acceptedQuote = (overrides: Doc = {}): Doc => ({
  id: QUOTE_ID,
  accountId: "acc-1",
  version: 4,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  clientId: CLIENT_ID,
  projectId: PROJECT_ID,
  clientSnapshot: { clientId: CLIENT_ID, displayName: "Acme SpA", currency: "EUR", snapshotAt: "2026-01-02T00:00:00.000Z" },
  quoteNumber: "1/2026",
  currency: "EUR",
  issueDate: "2026-01-02",
  expiryDate: "2026-02-02",
  subject: "Website redesign",
  notes: "Thanks!",
  lineItems: [
    computeLine({ description: "Design", quantity: 1, unitPriceMinor: 100000, taxRate: 22 }),
    computeLine({ description: "Exempt training", quantity: 1, unitPriceMinor: 5000, taxRate: 0, nature: "N4" }),
  ],
  subtotalMinor: 105000,
  discountMinor: 0,
  taxMinor: 22000,
  grandTotalMinor: 127000,
  status: "accepted",
  convertedInvoiceId: null,
  ...overrides,
});

const setup = (quote: Doc = acceptedQuote()) => {
  const mongo = fakeMongo({
    quotes: [quote],
    settings: [{ key: "business", accountId: "acc-1", data: { businessName: "Billy", timezone: "Europe/Rome" } }],
  });
  const router = createQuotesRouter({ db: mongo.db, emitter: { emit: () => undefined }, logger });
  return { ...mongo, drive: driveRouter(router) };
};

const convertCtx = (version: number) =>
  fakeCtx(ADMIN, { method: "POST", path: `/api/v1/quotes/${QUOTE_ID}/convert`, params: { id: QUOTE_ID }, body: { version } });

describe("POST /api/v1/quotes/:id/convert", () => {
  it("creates a linked DRAFT invoice and returns its id (quote converted)", async () => {
    const { drive, col } = setup();
    const ctx = convertCtx(4);
    await drive(ctx);

    expect(ctx.status).toBe(200);
    const data = (ctx.body as { data: { quote: Doc; invoice: { id: string; invoiceNumber: string | null; status: string } } }).data;
    expect(data.invoice.status).toBe("draft");
    expect(data.invoice.invoiceNumber).toBeNull();
    expect(data.quote.status).toBe("converted");
    expect(data.quote.convertedInvoiceId).toBe(data.invoice.id);

    const invoices = col("invoices").docs;
    expect(invoices).toHaveLength(1);
    const inv = invoices[0]!;
    expect(inv).toMatchObject({
      id: data.invoice.id,
      accountId: "acc-1",
      status: "draft",
      convertedFromQuoteId: QUOTE_ID,
      clientId: CLIENT_ID,
      subject: "Website redesign",
      projectId: PROJECT_ID,
      notes: "Thanks!",
      grandTotalMinor: 127000,
    });
    // FatturaPA Natura survives the conversion.
    expect((inv.lineItems as Doc[])[1]).toMatchObject({ description: "Exempt training", nature: "N4" });
    // Persisted quote is converted + linked.
    expect(col("quotes").docs[0]).toMatchObject({ status: "converted", convertedInvoiceId: data.invoice.id });
  });

  it("a stale version creates NO invoice and leaves the quote accepted", async () => {
    const { drive, col } = setup();
    await expect(drive(convertCtx(3))).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(col("invoices").docs).toHaveLength(0);
    expect(col("quotes").docs[0]).toMatchObject({ status: "accepted", convertedInvoiceId: null });
  });

  it("reuses an invoice already created from this quote (retry after a failed link)", async () => {
    const { drive, col } = setup();
    col("invoices").docs.push({
      id: "eeeeeeeeeeeeeeeeeeeeeeee",
      accountId: "acc-1",
      convertedFromQuoteId: QUOTE_ID,
      status: "draft",
      invoiceNumber: null,
      deletedAt: null,
    });
    const ctx = convertCtx(4);
    await drive(ctx);
    expect(col("invoices").docs).toHaveLength(1);
    expect(col("quotes").docs[0]).toMatchObject({ status: "converted", convertedInvoiceId: "eeeeeeeeeeeeeeeeeeeeeeee" });
  });

  it("never reuses ANOTHER account's invoice for the same quote id", async () => {
    const { drive, col } = setup();
    col("invoices").docs.push({
      id: "ffffffffffffffffffffffff",
      accountId: "other",
      convertedFromQuoteId: QUOTE_ID,
      status: "draft",
      deletedAt: null,
    });
    await drive(convertCtx(4));
    const linked = col("quotes").docs[0]!.convertedInvoiceId;
    expect(linked).not.toBe("ffffffffffffffffffffffff");
    expect(col("invoices").docs).toHaveLength(2);
  });

  it("rejects a quote that is not accepted (no invoice)", async () => {
    const { drive, col } = setup(acceptedQuote({ status: "sent" }));
    await expect(drive(convertCtx(4))).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(col("invoices").docs).toHaveLength(0);
  });
});
