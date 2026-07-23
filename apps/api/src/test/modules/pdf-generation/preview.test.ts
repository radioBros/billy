import { describe, it, expect } from "vitest";
import type { Db } from "mongodb";
import type { MinioConn } from "@/infrastructure/minio.js";
import { assembleBranding, renderPreviewHtml } from "@/modules/pdf-generation/preview.js";

/**
 * Preview assembly test. The api renders preview HTML PURELY via the template.ts
 * builders (no Playwright). We stub a minimal `Db` whose `collection(name).findOne`
 * resolves fixtures by collection name + filter — proving the branding assembler
 * mirrors the worker's field-mapping and that each document type renders.
 */

const settingsDocs: Record<string, { key: string; data: Record<string, unknown> }> = {
  branding: { key: "branding", data: { appName: "Acme Billing", primaryColor: "#2563eb" } },
  business: {
    key: "business",
    data: {
      businessName: "Acme S.p.A.",
      vatNumber: "IT99999999999",
      taxCode: "CFACME00A01H501Z",
      email: "info@acme.example",
      address: { line1: "Via Roma 1", city: "Rome", region: "RM", postalCode: "00100", country: "IT" },
    },
  },
  documents: { key: "documents", data: { logoPosition: "left", showBankDetails: true, contractHeaderHtml: "<div>Signed contract letterhead</div>" } },
};

const invoiceDoc = {
  id: "inv_1",
  invoiceNumber: "INV-2026-0001",
  currency: "EUR",
  issueDate: "2026-07-01",
  dueDate: "2026-07-31",
  clientSnapshot: { displayName: "Globex SPA" },
  bankSnapshot: { label: "Main EUR", details: "Bank: Banca Test\nIBAN: IT60X0542811101000000123456" },
  lineItems: [
    { description: "Consulting", quantity: 1, unitPriceMinor: 100000, lineSubtotalMinor: 100000, lineDiscountMinor: 0, lineTaxMinor: 0, lineTotalMinor: 100000 },
  ],
  subtotalMinor: 100000,
  discountMinor: 0,
  taxMinor: 0,
  grandTotalMinor: 100000,
};

const proformaDoc = {
  id: "pro_1",
  proformaNumber: "PRO-2026-0002",
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
};

const creditNoteDoc = {
  id: "cn_1",
  creditNoteNumber: "CN-2026-0003",
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
};

const contractDoc = {
  id: "ctr_1",
  clientId: "client_42", // real contracts carry only clientId (no embedded snapshot)
  title: "Managed Hosting 2026",
  startDate: "2026-01-01",
  endDate: "2026-12-31",
  currency: "EUR",
  valueMinor: 1200000,
  terms: "Payment <net 30>.",
  status: "active",
};

const byCollection: Record<string, Record<string, unknown>> = {
  invoices: invoiceDoc,
  proformas: proformaDoc,
  creditNotes: creditNoteDoc,
  contracts: contractDoc,
};

const stubDb = (): Db => {
  return {
    collection: (name: string) => ({
      findOne: async (filter: Record<string, unknown>) => {
        if (name === "settings") return settingsDocs[filter.key as string] ?? null;
        const doc = byCollection[name];
        return doc && (filter as { id?: string }).id === doc.id ? doc : null;
      },
    }),
  } as unknown as Db;
};

describe("assembleBranding", () => {
  it("maps branding/business/documents settings into a BrandingView (mirrors the worker)", async () => {
    const branding = await assembleBranding(stubDb(), "acct");
    expect(branding.appName).toBe("Acme Billing");
    expect(branding.companyName).toBe("Acme S.p.A.");
    expect(branding.companyAddressLines).toContain("Via Roma 1");
    expect(branding.companyVatNumber).toBe("IT99999999999");
    expect(branding.contractHeaderHtml).toBe("<div>Signed contract letterhead</div>");
    // Bank lines are NO LONGER sourced from settings — they come from the invoice's
    // bankSnapshot (see the renderPreviewHtml invoice test below). The assembler
    // returns an empty list; showBankDetails stays as the render gate.
    expect(branding.bankLines).toEqual([]);
    expect(branding.showBankDetails).toBe(true);
    expect(branding.companyLogoUrl).toBeUndefined(); // TODO(pdf-logo) gap
  });
});

describe("renderPreviewHtml", () => {
  it("renders invoice preview HTML", async () => {
    const html = await renderPreviewHtml(stubDb(), "invoice", "inv_1", "acct");
    expect(html).not.toBeNull();
    expect(html!).toContain("INV-2026-0001");
    expect(html!).toContain("Globex SPA");
    expect(html!).toContain("size: A4");
    // Bank block is rendered from the invoice's bankSnapshot (not settings).
    expect(html!).toContain("Bank details");
    expect(html!).toContain("Bank: Banca Test");
    expect(html!).toContain("IBAN: IT60X0542811101000000123456");
  });

  it("renders proforma preview via the invoice template (number mapped)", async () => {
    const html = await renderPreviewHtml(stubDb(), "proforma", "pro_1", "acct");
    expect(html!).toContain("PRO-2026-0002");
  });

  it("renders credit-note preview via the invoice template", async () => {
    const html = await renderPreviewHtml(stubDb(), "credit-note", "cn_1", "acct");
    expect(html!).toContain("CN-2026-0003");
  });

  it("renders contract preview via renderContractHtml (uses contractHeaderHtml)", async () => {
    const html = await renderPreviewHtml(stubDb(), "contract", "ctr_1", "acct");
    expect(html!).toContain("<strong>Contract</strong>: <strong>Managed Hosting 2026</strong>");
    expect(html!).toContain("Signed contract letterhead"); // contractHeaderHtml fragment
    expect(html!).toContain("Payment &lt;net 30&gt;"); // escaped terms
    expect(html!).toContain("client_42"); // clientId fallback (real contracts have no snapshot)
  });

  it("returns null when the document is not found", async () => {
    const html = await renderPreviewHtml(stubDb(), "invoice", "missing", "acct");
    expect(html).toBeNull();
  });
});

// ── Company logo resolution → base64 data URI (byte-consistent with the worker) ──

const LOGO_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic prefix

/** Db stub that ALSO serves a `documents` singleton with a logo + a `files` doc. */
const stubDbWithLogo = (logoFileId: string, fileDoc: Record<string, unknown> | null): Db => {
  return {
    collection: (name: string) => ({
      findOne: async (filter: Record<string, unknown>) => {
        if (name === "settings") {
          if (filter.key === "documents") {
            return { key: "documents", data: { logoPosition: "left", showBankDetails: true, companyLogoFileId: logoFileId } };
          }
          return settingsDocs[filter.key as string] ?? null;
        }
        if (name === "files") return (filter as { id?: string }).id === logoFileId ? fileDoc : null;
        const doc = byCollection[name];
        return doc && (filter as { id?: string }).id === doc.id ? doc : null;
      },
    }),
  } as unknown as Db;
};

const stubMinio = (): MinioConn =>
  ({
    client: {
      getObject: async () => {
        async function* gen() {
          yield LOGO_BYTES;
        }
        return gen();
      },
    },
  }) as unknown as MinioConn;

describe("renderPreviewHtml — company logo", () => {
  it("embeds a clean logo as a base64 data:image/... URI in an <img class=\"company-logo\">", async () => {
    const file = { id: "logo_1", objectKey: "logo/acct/clean.png", contentType: "image/png", scanStatus: "clean", deletedAt: null };
    const html = await renderPreviewHtml(stubDbWithLogo("logo_1", file), "invoice", "inv_1", "acct", stubMinio());
    expect(html!).toContain('<img class="company-logo"');
    expect(html!).toContain(`src="data:image/png;base64,${LOGO_BYTES.toString("base64")}"`);
  });

  it("omits the logo <img> for a non-clean (infected) file → text fallback", async () => {
    const file = { id: "logo_1", objectKey: "logo/acct/bad.png", contentType: "image/png", scanStatus: "infected", deletedAt: null };
    const html = await renderPreviewHtml(stubDbWithLogo("logo_1", file), "invoice", "inv_1", "acct", stubMinio());
    expect(html!).not.toContain('class="company-logo"');
  });

  it("omits the logo <img> when the file is missing → text fallback", async () => {
    const html = await renderPreviewHtml(stubDbWithLogo("logo_1", null), "invoice", "inv_1", "acct", stubMinio());
    expect(html!).not.toContain('class="company-logo"');
  });

  it("omits the logo <img> when no MinIO client is provided", async () => {
    const file = { id: "logo_1", objectKey: "logo/acct/clean.png", contentType: "image/png", scanStatus: "clean", deletedAt: null };
    const html = await renderPreviewHtml(stubDbWithLogo("logo_1", file), "invoice", "inv_1", "acct");
    expect(html!).not.toContain('class="company-logo"');
  });
});
