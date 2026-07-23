import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "@billy/shared";
import type { PdfJob } from "@billy/types";
import type { ProcessorContext } from "@/processors.js";

const locateCachedChromium = (): string | undefined => {
  const base = join(homedir(), "Library", "Caches", "ms-playwright");
  const candidates = [
    join(base, "chromium-1223", "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
  ];
  return candidates.find((p) => existsSync(p));
};
const CACHED_CHROMIUM = locateCachedChromium();
if (CACHED_CHROMIUM) process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE = CACHED_CHROMIUM;

/**
 * Worker pdf handler test. `minio` + `mongodb` are mocked (no live services); the
 * `playwright` render is REAL (Chromium is cached locally) so we prove
 * page.pdf() emits a genuine `%PDF-` buffer. If a real launch is unavailable the
 * test detects it and falls back to asserting the graceful-degradation path.
 */

// ── Mongo mock: findOne returns fixtures keyed by collection name ─────────────
const invoiceDoc = {
  id: "inv_1",
  invoiceNumber: "INV-2026-0009",
  currency: "EUR",
  issueDate: "2026-07-01",
  dueDate: "2026-07-31",
  clientSnapshot: { displayName: "Globex SPA", vatNumber: "IT01234567890" },
  // Bank block on the invoice comes from its snapshot (not settings).
  bankSnapshot: { label: "Main EUR", details: "Bank: Banca Test\nIBAN: IT60X0542811101000000123456" },
  lineItems: [
    {
      description: "Consulting",
      quantity: 2,
      unitPriceMinor: 50000,
      lineSubtotalMinor: 100000,
      lineDiscountMinor: 0,
      lineTaxMinor: 22000,
      lineTotalMinor: 122000,
      taxRate: 22,
    },
  ],
  subtotalMinor: 100000,
  discountMinor: 0,
  taxMinor: 22000,
  grandTotalMinor: 122000,
  deletedAt: null,
};

const proformaDoc = {
  id: "pro_1",
  proformaNumber: "PRO-2026-0003",
  currency: "EUR",
  issueDate: "2026-07-01",
  expiryDate: "2026-07-31",
  clientSnapshot: { displayName: "Globex SPA" },
  lineItems: [
    { description: "Preview", quantity: 1, unitPriceMinor: 50000, lineSubtotalMinor: 50000, lineDiscountMinor: 0, lineTaxMinor: 0, lineTotalMinor: 50000 },
  ],
  subtotalMinor: 50000,
  discountMinor: 0,
  taxMinor: 0,
  grandTotalMinor: 50000,
  deletedAt: null,
};

const creditNoteDoc = {
  id: "cn_1",
  creditNoteNumber: "CN-2026-0002",
  currency: "EUR",
  issueDate: "2026-07-05",
  clientSnapshot: { displayName: "Globex SPA" },
  lineItems: [
    { description: "Refund", quantity: 1, unitPriceMinor: 20000, lineSubtotalMinor: 20000, lineDiscountMinor: 0, lineTaxMinor: 0, lineTotalMinor: 20000 },
  ],
  subtotalMinor: 20000,
  discountMinor: 0,
  taxMinor: 0,
  grandTotalMinor: 20000,
  deletedAt: null,
};

const contractDoc = {
  id: "ctr_1",
  clientId: "client_42", // real contracts carry only clientId (no embedded snapshot)
  title: "Managed Hosting 2026",
  type: "hosting",
  status: "active",
  startDate: "2026-01-01",
  endDate: "2026-12-31",
  valueMinor: 1200000,
  currency: "EUR",
  terms: "Payment <net 30>; auto-renews annually.",
  deletedAt: null,
};

/** Captures the effective FileObject written by the upsert (merged $set/$setOnInsert). */
const upsertedDocs: Record<string, unknown>[] = [];

const findOne = vi.fn(async (filter: Record<string, unknown>) => {
  // Branding lookup.
  if (filter.key === "branding") {
    return { key: "branding", data: { appName: "Acme Billing", primaryColor: "#2563eb" } };
  }
  // Business settings — company identity for the new header/footer. Bank details
  // are NOT here anymore: they come from the invoice's bankSnapshot.
  if (filter.key === "business") {
    return {
      key: "business",
      data: {
        businessName: "Acme S.p.A.",
        vatNumber: "IT99999999999",
        taxCode: "CFACME00A01H501Z",
        email: "info@acme.example",
        address: { line1: "Via Roma 1", city: "Rome", region: "RM", postalCode: "00100", country: "IT" },
      },
    };
  }
  // Documents settings — logo position + bank-details toggle.
  if (filter.key === "documents") {
    return { key: "documents", data: { logoPosition: "left", showBankDetails: true, contractHeaderHtml: "<div>Signed contract letterhead</div>" } };
  }
  // FileObject lookups (logo resolution) — keyed by the `id` string field.
  if (filter.id === "logo_clean") {
    return { id: "logo_clean", objectKey: "logo/acct/clean.png", contentType: "image/png", scanStatus: "clean", deletedAt: null };
  }
  if (filter.id === "logo_infected") {
    return { id: "logo_infected", objectKey: "logo/acct/bad.png", contentType: "image/png", scanStatus: "infected", deletedAt: null };
  }
  // Document lookups by id (collection name is ignored by the mock — keyed by id).
  if (filter.id === "inv_1") return invoiceDoc;
  if (filter.id === "pro_1") return proformaDoc;
  if (filter.id === "cn_1") return creditNoteDoc;
  if (filter.id === "ctr_1") return contractDoc;
  return null;
});

interface UpdateSpec {
  $set?: Record<string, unknown>;
  $inc?: Record<string, unknown>;
  $setOnInsert?: Record<string, unknown>;
}
const findOneAndUpdate = vi.fn(async (_filter: Record<string, unknown>, update: UpdateSpec) => {
  // Simulate a fresh insert (upsert path): merge $set + $setOnInsert + version 1.
  const merged = {
    ...(update.$setOnInsert ?? {}),
    ...(update.$set ?? {}),
    version: 1,
  } as Record<string, unknown>;
  upsertedDocs.push(merged);
  return merged;
});

vi.mock("mongodb", () => {
  class ObjectId {
    #hex: string;
    constructor() {
      this.#hex = "a".repeat(24);
    }
    toHexString(): string {
      return this.#hex;
    }
  }
  class MongoClient {
    db() {
      return {
        collection: () => ({ findOne, findOneAndUpdate }),
      };
    }
  }
  return { MongoClient, ObjectId };
});

// ── MinIO mock: capture putObject args ────────────────────────────────────────
const putObject = vi.fn(
  async (
    _bucket: string,
    _objectKey: string,
    _buf: Buffer,
    _size: number,
    _meta: Record<string, string>,
  ) => ({ etag: "etag" }),
);
// getObject returns a small async-iterable "stream" of the logo bytes.
const LOGO_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic prefix
const getObject = vi.fn(async (_bucket: string, _objectKey: string) => {
  async function* gen() {
    yield LOGO_BYTES;
  }
  return gen();
});
vi.mock("minio", () => {
  class Client {
    putObject = putObject;
    getObject = getObject;
  }
  return { Client };
});

const stubCtx = (): ProcessorContext => {
  const noop = vi.fn();
  const logger = { info: noop, error: noop, warn: noop, debug: noop } as unknown as Logger;
  return { logger };
};

let realRenderRan = false;

beforeEach(() => {
  upsertedDocs.length = 0;
  putObject.mockClear();
  getObject.mockClear();
  findOne.mockClear();
  findOneAndUpdate.mockClear();
});

describe("pdfHandler — render + store", () => {
  it("renders a real %PDF- buffer, stores it in MinIO, and writes a FileObject", async () => {
    const { pdfHandler } = await import("@/handlers/pdf.js");
    const payload: PdfJob = { documentType: "invoice", documentId: "inv_1", accountId: "biz_1" };

    let result: Awaited<ReturnType<typeof pdfHandler>>;
    try {
      result = await pdfHandler(payload, stubCtx());
      realRenderRan = true;
    } catch (err) {
      if (CACHED_CHROMIUM) {
        // A browser IS available — a failure here is a real bug, not degradation.
        throw err;
      }
      // No Chromium available at all → assert the graceful-degradation path.
      expect((err as Error).message).toMatch(/PDF|Chromium/i);
      return;
    }

    // 1) MinIO received a real PDF buffer at a server-generated objectKey.
    expect(putObject).toHaveBeenCalledTimes(1);
    const [bucket, objectKey, buf, size, meta] = putObject.mock.calls[0]!;
    expect(bucket).toBe("billy-files");
    expect(objectKey).toMatch(/^invoice\/inv_1\/[0-9a-f-]{36}$/);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(size).toBe(buf.length);
    expect(meta).toEqual({ "Content-Type": "application/pdf" });

    // 2) A FileObject was upserted into the "files" collection with the exact
    //    shape BaseRepository persists / FileService reads back (id, version, ISO
    //    timestamps, soft-delete + archive nulls, scanStatus clean).
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    const upsertFilter = findOneAndUpdate.mock.calls[0]![0] as Record<string, unknown>;
    expect(upsertFilter).toMatchObject({ ownerType: "invoice", ownerId: "inv_1", contentType: "application/pdf" });
    expect(upsertedDocs).toHaveLength(1);
    const fo = upsertedDocs[0]!;
    expect(fo.ownerType).toBe("invoice");
    expect(fo.ownerId).toBe("inv_1");
    expect(fo.contentType).toBe("application/pdf");
    expect(fo.filename).toBe("INV-2026-0009.pdf");
    expect(fo.scanStatus).toBe("clean");
    expect(fo.uploadedBy).toBe("system");
    expect(fo.objectKey).toBe(objectKey);
    expect(fo.sizeBytes).toBe(size);
    expect(typeof fo.id).toBe("string");
    expect(fo.version).toBe(1);
    expect(typeof fo.createdAt).toBe("string");
    expect(typeof fo.updatedAt).toBe("string");
    expect(fo.deletedAt).toBeNull();
    expect(fo.archivedAt).toBeNull();

    // 3) Handler result surface.
    expect(result.fileId).toBe(fo.id);
    expect(result.objectKey).toBe(objectKey);
    expect(result.sizeBytes).toBe(size);
  }, 30000);

  it("throws PDF_GENERATION_FAILED for an unsupported document type", async () => {
    const { pdfHandler } = await import("@/handlers/pdf.js");
    // `receipt` is in the PdfJob union but not implemented → the genuine unsupported case.
    const payload = { documentType: "receipt", documentId: "c1", accountId: "biz_1" } as unknown as PdfJob;
    await expect(pdfHandler(payload, stubCtx())).rejects.toThrow(/Unsupported PDF document type/);
  });

  it("throws PDF_GENERATION_FAILED when the invoice is not found", async () => {
    const { pdfHandler } = await import("@/handlers/pdf.js");
    const payload: PdfJob = { documentType: "invoice", documentId: "missing", accountId: "biz_1" };
    await expect(pdfHandler(payload, stubCtx())).rejects.toThrow(/Invoice not found/);
  });

  it("renders + stores a proforma via the invoice template (proformaNumber → filename)", async () => {
    const { pdfHandler } = await import("@/handlers/pdf.js");
    const payload: PdfJob = { documentType: "proforma", documentId: "pro_1", accountId: "biz_1" };
    try {
      const result = await pdfHandler(payload, stubCtx());
      expect(result.fileId).toBeTruthy();
    } catch (err) {
      if (CACHED_CHROMIUM) throw err;
      expect((err as Error).message).toMatch(/PDF|Chromium/i);
      return;
    }
    const [, objectKey] = putObject.mock.calls[0]!;
    expect(objectKey).toMatch(/^proforma\/pro_1\//);
    expect(upsertedDocs[0]!.ownerType).toBe("proforma");
    expect(upsertedDocs[0]!.filename).toBe("PRO-2026-0003.pdf");
  }, 30000);

  it("renders + stores a credit-note via the invoice template", async () => {
    const { pdfHandler } = await import("@/handlers/pdf.js");
    const payload: PdfJob = { documentType: "credit-note", documentId: "cn_1", accountId: "biz_1" };
    try {
      const result = await pdfHandler(payload, stubCtx());
      expect(result.fileId).toBeTruthy();
    } catch (err) {
      if (CACHED_CHROMIUM) throw err;
      expect((err as Error).message).toMatch(/PDF|Chromium/i);
      return;
    }
    expect(upsertedDocs[0]!.ownerType).toBe("credit-note");
    expect(upsertedDocs[0]!.filename).toBe("CN-2026-0002.pdf");
  }, 30000);

  it("renders + stores a contract via renderContractHtml (title → filename fallback)", async () => {
    const { pdfHandler } = await import("@/handlers/pdf.js");
    const payload: PdfJob = { documentType: "contract", documentId: "ctr_1", accountId: "biz_1" };
    try {
      const result = await pdfHandler(payload, stubCtx());
      expect(result.fileId).toBeTruthy();
    } catch (err) {
      if (CACHED_CHROMIUM) throw err;
      expect((err as Error).message).toMatch(/PDF|Chromium/i);
      return;
    }
    const [, objectKey] = putObject.mock.calls[0]!;
    expect(objectKey).toMatch(/^contract\/ctr_1\//);
    expect(upsertedDocs[0]!.ownerType).toBe("contract");
    expect(upsertedDocs[0]!.filename).toBe("Managed Hosting 2026.pdf");
  }, 30000);

  it("throws PDF_GENERATION_FAILED when the contract is not found", async () => {
    const { pdfHandler } = await import("@/handlers/pdf.js");
    const payload: PdfJob = { documentType: "contract", documentId: "missing", accountId: "biz_1" };
    await expect(pdfHandler(payload, stubCtx())).rejects.toThrow(/Contract not found/);
  });

  it("(diagnostic) a real Chromium render ran when a browser was available", () => {
    // When a cached Chromium is present, the first test MUST have taken the real
    // render path (proving page.pdf → %PDF-). Otherwise it degraded gracefully.
    if (CACHED_CHROMIUM) expect(realRenderRan).toBe(true);
  });
});

describe("renderInvoiceHtml — redesigned layout (byte-identical to api template.ts)", () => {
  const branding = {
    appName: "Acme Billing",
    primaryColor: "#2563eb",
    companyName: "Acme S.p.A.",
    companyAddressLines: ["Via Roma 1", "00100 Rome (RM)"],
    companyVatNumber: "IT99999999999",
    companyTaxCode: "CFACME00A01H501Z",
    companyEmail: "info@acme.example",
    logoPosition: "left" as const,
    showBankDetails: true,
    bankLines: ["Bank: Banca Test", "IBAN: IT60X0542811101000000123456"],
  };
  const invoice = {
    invoiceNumber: "INV-2026-0009",
    currency: "EUR",
    issueDate: "2026-07-01",
    dueDate: "2026-07-31",
    clientSnapshot: { displayName: "Globex SPA", vatNumber: "IT01234567890" },
    lineItems: [
      {
        description: "Consulting",
        quantity: 2,
        unitPriceMinor: 50000,
        lineSubtotalMinor: 100000,
        lineDiscountMinor: 0,
        lineTaxMinor: 22000,
        lineTotalMinor: 122000,
        taxRate: 22,
      },
    ],
    subtotalMinor: 100000,
    discountMinor: 0,
    taxMinor: 22000,
    grandTotalMinor: 122000,
  };

  it("renders the company header, big grand-total row, and bank-details block", async () => {
    const { renderInvoiceHtml } = await import("@/handlers/pdf.js");
    const html = renderInvoiceHtml(invoice, branding);
    // Header company block + title/number/date heading.
    expect(html).toContain("Acme S.p.A.");
    expect(html).toContain("Via Roma 1");
    expect(html).toContain("VAT IT99999999999");
    expect(html).toContain("of <strong>2026-07-01</strong>");
    // Single recipient block (client data only) + separate dates block; no Sender column.
    expect(html).toContain("Recipient");
    expect(html).toContain('class="block dates"');
    expect(html).not.toContain("Sender");
    expect(html).toContain("Globex SPA");
    // Big grand-total row (no payment → Total is the primary grand total).
    expect(html).toContain('class="grand-total"');
    expect(html).toContain(".totals tr.grand-total td");
    // Bank-details block.
    expect(html).toContain('class="bank-details"');
    expect(html).toContain("Bank: Banca Test");
  });

  it("renders the recipient billing address with postal/city/province/country on ONE line", async () => {
    const { renderInvoiceHtml } = await import("@/handlers/pdf.js");
    const withAddress = renderInvoiceHtml(
      {
        ...invoice,
        clientSnapshot: {
          displayName: "Globex SPA",
          billingAddress: { line1: "Via Milano 5", city: "Milan", region: "MI", postalCode: "20100", country: "IT" },
        },
      },
      branding,
    );
    // Country renders as its localized full name (default locale "en": IT → "Italy").
    expect(withAddress).toContain("Via Milano 5");
    expect(withAddress).toContain('<div class="line">20100 Milan (MI) Italy</div>');
    expect(withAddress).not.toContain('<div class="line">Italy</div>');
  });

  it("aligns the header company column by logoPosition and omits the bank block per branding flags", async () => {
    const { renderInvoiceHtml } = await import("@/handlers/pdf.js");
    const right = renderInvoiceHtml(invoice, { ...branding, logoPosition: "right", showBankDetails: false });
    expect(right).toContain('class="company-col "');
    expect(right).not.toContain('class="company-col align-right"');
    expect(right).not.toContain('class="bank-details"');
  });

  it("keeps the doc number in the header even when a custom documentHeaderHtml is set", async () => {
    const { renderInvoiceHtml } = await import("@/handlers/pdf.js");
    const custom = renderInvoiceHtml(invoice, { ...branding, documentHeaderHtml: "<div>Custom letterhead</div>" });
    expect(custom).toContain("Custom letterhead"); // custom fragment replaces only the logo column
    expect(custom).toContain("INV-2026-0009"); // number/date heading still rendered
    expect(custom).toContain("of <strong>2026-07-01</strong>");
  });
});

describe("renderContractHtml — contract layout (byte-identical to api template.ts)", () => {
  const branding = {
    appName: "Acme Billing",
    primaryColor: "#2563eb",
    companyName: "Acme S.p.A.",
    companyAddressLines: ["Via Roma 1", "00100 Rome (RM)"],
    companyVatNumber: "IT99999999999",
    companyEmail: "info@acme.example",
    logoPosition: "left" as const,
  };
  const contract = {
    clientId: "client_42", // real contracts carry only clientId (no embedded snapshot)
    title: "Managed Hosting 2026",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    currency: "EUR",
    valueMinor: 1200000,
    terms: "Payment <net 30>; auto-renews annually.",
    status: "active",
  };

  it("renders the contract heading, parties, dates, escaped terms, and value", async () => {
    const { renderContractHtml } = await import("@/handlers/pdf.js");
    const html = renderContractHtml(contract, branding);
    expect(html).toContain("<strong>Contract</strong>: <strong>Managed Hosting 2026</strong>");
    expect(html).toContain("Provider");
    expect(html).toContain("Client");
    expect(html).toContain("client_42"); // clientId fallback (no snapshot on real contracts)
    expect(html).toContain("Start date: 2026-01-01");
    expect(html).toContain("End date: 2026-12-31");
    expect(html).toContain("Terms");
    expect(html).toContain("Payment &lt;net 30&gt;"); // escaped
    expect(html).toContain("EUR 12,000.00"); // contract value
  });

  it("falls back to open-ended when endDate is absent and uses contractFooterHtml when set", async () => {
    const { renderContractHtml } = await import("@/handlers/pdf.js");
    const html = renderContractHtml(
      { ...contract, endDate: null },
      { ...branding, contractFooterHtml: "<div>Signed electronically</div>" },
    );
    expect(html).toContain("open-ended");
    expect(html).toContain("End date: —");
    expect(html).toContain("Signed electronically");
  });
});

describe("resolveLogoDataUri — company logo → base64 data URI", () => {
  it("returns a data:image/... URI for a clean file (bytes fetched from MinIO)", async () => {
    const { resolveLogoDataUri } = await import("@/handlers/pdf.js");
    const uri = await resolveLogoDataUri("acct", "logo_clean");
    expect(uri).toBe(`data:image/png;base64,${LOGO_BYTES.toString("base64")}`);
    expect(uri!.startsWith("data:image/png;base64,")).toBe(true);
    expect(getObject).toHaveBeenCalledWith("billy-files", "logo/acct/clean.png");
  });

  it("returns undefined when no fileId is set (never touches storage)", async () => {
    const { resolveLogoDataUri } = await import("@/handlers/pdf.js");
    expect(await resolveLogoDataUri("acct", null)).toBeUndefined();
    expect(await resolveLogoDataUri("acct", undefined)).toBeUndefined();
    expect(getObject).not.toHaveBeenCalled();
  });

  it("returns undefined when the file is missing", async () => {
    const { resolveLogoDataUri } = await import("@/handlers/pdf.js");
    expect(await resolveLogoDataUri("acct", "does_not_exist")).toBeUndefined();
    expect(getObject).not.toHaveBeenCalled();
  });

  it("returns undefined for a non-clean (infected) file — never embeds it", async () => {
    const { resolveLogoDataUri } = await import("@/handlers/pdf.js");
    expect(await resolveLogoDataUri("acct", "logo_infected")).toBeUndefined();
    expect(getObject).not.toHaveBeenCalled();
  });
});
