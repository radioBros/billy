import { describe, it, expect } from "vitest";
import {
  formatMoney,
  escapeHtml,
  renderInvoiceHtml,
  renderQuoteHtml,
  renderContractHtml,
  type InvoiceView,
  type QuoteView,
  type ContractView,
  type BrandingView,
  type TemplateLineItem,
} from "@/modules/pdf-generation/template.js";

const branding: BrandingView = {
  appName: "Acme Billing",
  primaryColor: "#2563eb",
  companyName: "Acme S.p.A.",
  companyAddressLines: ["Via Roma 1", "00100 Rome (RM)"],
  companyVatNumber: "IT99999999999",
  companyTaxCode: "CFACME00A01H501Z",
  companyEmail: "info@acme.example",
  logoPosition: "left",
  showBankDetails: true,
  bankLines: ["Bank: Banca Test", "IBAN: IT60X0542811101000000123456"],
};

const line = (overrides: Partial<TemplateLineItem>): TemplateLineItem => {
  return {
    description: "Item",
    quantity: 1,
    unitPriceMinor: 10000,
    lineSubtotalMinor: 10000,
    lineDiscountMinor: 0,
    lineTaxMinor: 0,
    lineTotalMinor: 10000,
    ...overrides,
  };
};

describe("formatMoney — integer minor units, no float math", () => {
  it("formats 2-decimal currencies with thousands separators", () => {
    expect(formatMoney(123456, "EUR")).toBe("EUR 1,234.56");
    expect(formatMoney(5, "USD")).toBe("USD 0.05");
    expect(formatMoney(100, "USD")).toBe("USD 1.00");
  });
  it("handles negative amounts", () => {
    expect(formatMoney(-2500, "GBP")).toBe("-GBP 25.00");
  });
  it("respects zero-decimal currencies", () => {
    expect(formatMoney(1500, "JPY")).toBe("JPY 1,500");
  });
  it("respects three-decimal currencies", () => {
    expect(formatMoney(1234, "KWD")).toBe("KWD 1.234");
  });
});

describe("escapeHtml", () => {
  it("escapes html-significant characters", () => {
    expect(escapeHtml('<b>&"\'')).toBe("&lt;b&gt;&amp;&quot;&#39;");
  });
});

describe("renderInvoiceHtml", () => {
  const invoice: InvoiceView = {
    invoiceNumber: "INV-2026-0007",
    currency: "EUR",
    issueDate: "2026-07-01",
    dueDate: "2026-07-31",
    clientSnapshot: { displayName: "Globex SPA", vatNumber: "IT01234567890", email: "ap@globex.example" },
    lineItems: [
      line({ description: "Consulting", quantity: 3, unitPriceMinor: 50000, taxRate: 22, lineSubtotalMinor: 150000, lineTaxMinor: 33000, lineTotalMinor: 183000 }),
      line({ description: "License", quantity: 1, unitPriceMinor: 20000, lineSubtotalMinor: 20000, lineTotalMinor: 20000 }),
    ],
    subtotalMinor: 170000,
    discountMinor: 0,
    taxMinor: 33000,
    grandTotalMinor: 203000,
    amountPaidMinor: 100000,
    amountDueMinor: 103000,
    notes: "Thank you <for> business",
    status: "sent",
  };

  const html = renderInvoiceHtml(invoice, branding);

  it("renders the header title/number/date heading and the company identity block", () => {
    // Doc title heading: "INVOICE no. {number} of {issueDate}".
    expect(html).toContain("Invoice");
    expect(html).toContain("INV-2026-0007");
    expect(html).toContain("of <strong>2026-07-01</strong>");
    expect(html).toContain('class="doc-title"');
    // Company identity block (from the extended BrandingView).
    expect(html).toContain("Acme S.p.A.");
    expect(html).toContain("Via Roma 1");
    expect(html).toContain("VAT IT99999999999");
    expect(html).toContain("C.F. CFACME00A01H501Z");
  });
  it("renders a single recipient block (client data only) plus a separate dates block — no redundant Sender column", () => {
    // The company/sender identity lives ONLY in the header now; the meta area holds
    // just the recipient (client) block and a small dates block beside it.
    expect(html).toContain("Recipient");
    expect(html).toContain('class="block dates"');
    expect(html).not.toContain("Sender"); // no redundant sender column
    // Company VAT/email appear once, in the header company block — not repeated below.
    expect(html).toContain("VAT IT99999999999");
    expect(html).toContain("info@acme.example");
  });
  it("includes the client snapshot", () => {
    expect(html).toContain("Globex SPA");
    expect(html).toContain("IT01234567890");
    expect(html).toContain("ap@globex.example");
  });
  it("renders the recipient billing address with postal/city/province/country on ONE line", () => {
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
    // Street line, then the single locality line carrying country — never split apart.
    // Country renders as its localized full name (default locale "en": IT → "Italy").
    expect(withAddress).toContain("Via Milano 5");
    expect(withAddress).toContain('<div class="line">20100 Milan (MI) Italy</div>');
    // Country must not appear on its own separate line.
    expect(withAddress).not.toContain('<div class="line">Italy</div>');
  });
  it("renders each line item with its formatted total", () => {
    expect(html).toContain("Consulting");
    expect(html).toContain("License");
    expect(html).toContain("EUR 1,830.00"); // 183000 line total
  });
  it("renders subtotal / tax / grand total from the server-computed fields", () => {
    expect(html).toContain("EUR 1,700.00"); // subtotal
    expect(html).toContain("EUR 330.00"); // tax
    expect(html).toContain("EUR 2,030.00"); // grand total
  });
  it("renders paid + amount due when a payment exists, with Amount Due as the big grand-total row", () => {
    expect(html).toContain("Amount Due");
    expect(html).toContain("EUR 1,030.00"); // amount due
    expect(html).toContain("-EUR 1,000.00"); // paid (shown negative)
    // The primary grand-total figure carries the big-total class (26px, primary color).
    expect(html).toContain('class="grand-total"');
    expect(html).toContain(".totals tr.grand-total td");
  });
  it("renders the bank-details block when showBankDetails and bank lines are present", () => {
    expect(html).toContain('class="bank-details"');
    expect(html).toContain("Bank: Banca Test");
    expect(html).toContain("IBAN: IT60X0542811101000000123456");
  });
  it("omits the bank-details block when showBankDetails is false", () => {
    const noBank = renderInvoiceHtml(invoice, { ...branding, showBankDetails: false });
    expect(noBank).not.toContain('class="bank-details"');
  });
  it("aligns the header company column by logoPosition", () => {
    const right = renderInvoiceHtml(invoice, { ...branding, logoPosition: "right" });
    // Company details column is left-aligned (no align-right) when logo is on the right.
    expect(right).toContain('class="company-col "');
    expect(right).not.toContain('class="company-col align-right"');
    // Default (logo left) → company column is right-aligned.
    expect(html).toContain('class="company-col align-right"');
  });
  it("escapes notes and includes branding + A4 print CSS", () => {
    expect(html).toContain("Thank you &lt;for&gt; business");
    expect(html).toContain("Acme Billing");
    expect(html).toContain("size: A4");
    expect(html).toContain("--brand-primary:#2563eb");
  });
  it("falls back to DRAFT when no number assigned", () => {
    const draft = renderInvoiceHtml({ ...invoice, invoiceNumber: null }, branding);
    expect(draft).toContain("DRAFT");
  });
  it("keeps the doc number in the header even when a custom documentHeaderHtml is set", () => {
    const custom = renderInvoiceHtml(invoice, { ...branding, documentHeaderHtml: "<div>Custom letterhead</div>" });
    expect(custom).toContain("Custom letterhead"); // custom fragment replaces only the logo column
    expect(custom).toContain("INV-2026-0007"); // number/date heading still rendered
    expect(custom).toContain("of <strong>2026-07-01</strong>");
  });
});

describe("renderQuoteHtml", () => {
  const quote: QuoteView = {
    quoteNumber: "Q-2026-0003",
    currency: "USD",
    issueDate: "2026-07-10",
    expiryDate: "2026-08-10",
    clientSnapshot: { displayName: "Initech" },
    lineItems: [line({ description: "Design work", quantity: 2, unitPriceMinor: 25000, lineSubtotalMinor: 50000, lineTotalMinor: 50000 })],
    subtotalMinor: 50000,
    discountMinor: 5000,
    taxMinor: 0,
    grandTotalMinor: 45000,
    notes: "Valid 30 days",
  };
  const html = renderQuoteHtml(quote, branding);

  it("includes number, dates, client, and totals", () => {
    expect(html).toContain("Quote");
    expect(html).toContain("Q-2026-0003");
    expect(html).toContain("Valid until: 2026-08-10");
    expect(html).toContain("Initech");
    expect(html).toContain("Design work");
    expect(html).toContain("USD 450.00"); // grand total
    expect(html).toContain("-USD 50.00"); // discount shown negative
  });
});

describe("renderContractHtml", () => {
  const contract: ContractView = {
    clientId: "client_42", // real contracts carry only clientId (no embedded snapshot)
    title: "Managed Hosting 2026",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    currency: "EUR",
    valueMinor: 1200000,
    terms: "Payment <net 30>; auto-renews annually.",
    status: "active",
  };
  const html = renderContractHtml(contract, branding);

  it("renders the contract heading, parties, dates, escaped terms, and value", () => {
    // Contract-shaped heading (composed inside renderContractHtml, NOT the shared header).
    expect(html).toContain("<strong>Contract</strong>: <strong>Managed Hosting 2026</strong>");
    expect(html).toContain("2026-01-01 — 2026-12-31");
    // Parties. Contracts have only clientId → it renders as the client display name.
    expect(html).toContain("Provider");
    expect(html).toContain("Client");
    expect(html).toContain("client_42");
    // Dates in the body.
    expect(html).toContain("Start date: 2026-01-01");
    expect(html).toContain("End date: 2026-12-31");
    // Escaped terms.
    expect(html).toContain("Terms");
    expect(html).toContain("Payment &lt;net 30&gt;");
    // Contract value.
    expect(html).toContain("EUR 12,000.00");
    // Reuses the A4 print CSS shell + branding var.
    expect(html).toContain("size: A4");
    expect(html).toContain("--brand-primary:#2563eb");
  });

  it("shows open-ended when endDate is absent", () => {
    const openEnded = renderContractHtml({ ...contract, endDate: null }, branding);
    expect(openEnded).toContain("open-ended");
    expect(openEnded).toContain("End date: —");
  });

  it("prefers contractHeaderHtml/contractFooterHtml over the document fragments", () => {
    const custom = renderContractHtml(contract, {
      ...branding,
      documentHeaderHtml: "<div>Doc letterhead</div>",
      documentFooterHtml: "<div>Doc footer</div>",
      contractHeaderHtml: "<div>Contract letterhead</div>",
      contractFooterHtml: "<div>Contract footer</div>",
    });
    expect(custom).toContain("Contract letterhead");
    expect(custom).toContain("Contract footer");
    expect(custom).not.toContain("Doc letterhead");
    // Heading always renders regardless of the custom header fragment.
    expect(custom).toContain("Managed Hosting 2026");
  });

  it("falls back to documentHeaderHtml/FooterHtml when contract-specific fragments are absent", () => {
    const fallback = renderContractHtml(contract, {
      ...branding,
      documentHeaderHtml: "<div>Doc letterhead</div>",
      documentFooterHtml: "<div>Doc footer</div>",
    });
    expect(fallback).toContain("Doc letterhead");
    expect(fallback).toContain("Doc footer");
  });
});
