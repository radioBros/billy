import { describe, it, expect } from "vitest";
import { mapDocument, splitStreet, splitVat, toFatturaText } from "../mapper.js";
import type { MapperSettings, SourceDocument, SourceSeller } from "../types.js";

const settings: MapperSettings = {
  taxRegime: "RF01",
  defaultPaymentConditions: "TP02",
  defaultPaymentMethod: "MP05",
  defaultZeroRateNature: null,
  zeroRateLawReference: null,
  bollo: { mode: "auto", threshold: "77.47", amount: "2.00" },
  creditNoteNumberPrefix: "NC",
};
const seller: SourceSeller = {
  name: "Fornitore S.r.l.",
  vatNumber: "IT01234567890",
  taxCode: "01234567890",
  address: { line1: "Via Roma 12", city: "Milano", region: "MI", postalCode: "20100", country: "IT" },
};
const line = (over: Record<string, unknown> = {}) => ({
  description: "Consulenza",
  quantity: 10,
  unitPriceMinor: 10000,
  discountRate: 0,
  taxRate: 22,
  lineSubtotalMinor: 100000,
  lineDiscountMinor: 0,
  lineTaxMinor: 22000,
  lineTotalMinor: 122000,
  ...over,
});
const doc = (over: Partial<SourceDocument> = {}): SourceDocument => ({
  kind: "invoice",
  number: "42/2026",
  issueDate: "2026-09-01",
  dueDate: "2026-10-01",
  currency: "EUR",
  grandTotalMinor: 122000,
  iban: "IT60 X054 2811 1010 0000 0123 456",
  lines: [line()],
  client: {
    type: "company",
    displayName: "Cliente",
    legalName: "Cliente S.p.A.",
    vatNumber: "IT09876543210",
    recipientCode: "abc1234",
    country: "IT",
    billingAddress: { line1: "Corso Buenos Aires 5", city: "Milano", region: "MI", postalCode: "20124", country: "IT" },
  },
  ...over,
});
const ctx = { passoSellerId: "seller-1", crmInvoiceRef: "billy:acct:inv1" };
const codes = (r: ReturnType<typeof mapDocument>) => r.issues.map((i) => i.code);

describe("mapDocument — happy path (B2B, 22%)", () => {
  const r = mapDocument(doc(), seller, settings, ctx);
  it("is ok and builds the PASSO body", () => {
    expect(r.ok).toBe(true);
    expect(r.body?.sellerId).toBe("seller-1");
    const inv = r.body!.invoice;
    expect(inv).toMatchObject({ documentType: "TD01", number: "42/2026", date: "2026-09-01", format: "FPR12", recipientCode: "ABC1234" });
  });
  it("splits VAT ids, street numbers and keeps money as strings", () => {
    const inv = r.body!.invoice;
    expect(inv.seller.vatId).toEqual({ country: "IT", code: "01234567890" });
    expect(inv.buyer.vatId).toEqual({ country: "IT", code: "09876543210" });
    expect(inv.buyer.address).toMatchObject({ street: "Corso Buenos Aires", streetNumber: "5", province: "MI" });
    expect(inv.lines[0]).toMatchObject({ lineNumber: 1, quantity: "10.00", unitPrice: "100.00", totalPrice: "1000.00", vatRate: "22.00" });
    expect(inv.summaries).toEqual([{ vatRate: "22.00", taxableAmount: "1000.00", taxAmount: "220.00", vatCollectability: "I" }]);
    expect(inv.payment).toMatchObject({ conditions: "TP02", method: "MP05", amount: "1220.00", dueDate: "2026-10-01", iban: "IT60X0542811101000000123456" });
    expect(inv.stampDuty).toBeUndefined();
  });
});

describe("mapDocument — routing", () => {
  it("uses 0000000 + PEC when there is no SDI code", () => {
    const d = doc();
    d.client.recipientCode = null;
    d.client.pecEmail = "cliente@pec.it";
    const inv = mapDocument(d, seller, settings, ctx).body!.invoice;
    expect(inv.recipientCode).toBe("0000000");
    expect(inv.recipientPec).toBe("cliente@pec.it");
  });
  it("blocks a client with neither SDI code nor PEC (consumer)", () => {
    const d = doc();
    d.client.recipientCode = null;
    const r = mapDocument(d, seller, settings, ctx);
    expect(r.ok).toBe(false);
    expect(r.body).toBeNull();
    expect(codes(r)).toContain("client.routing_missing");
  });
  it("blocks public-administration (6 char) codes", () => {
    const d = doc();
    d.client.recipientCode = "UF1234";
    expect(codes(mapDocument(d, seller, settings, ctx))).toContain("client.public_administration_unsupported");
  });
  it("uses XXXXXXX and 00000 for a foreign buyer, with the VAT prefix as country", () => {
    const d = doc();
    d.client = {
      type: "company", displayName: "ACME GmbH", legalName: "ACME GmbH", vatNumber: "DE123456789", recipientCode: null,
      billingAddress: { line1: "Hauptstr. 1", city: "Berlin", postalCode: "10115", country: "DE" },
    };
    const inv = mapDocument(d, seller, settings, ctx).body!.invoice;
    expect(inv.recipientCode).toBe("XXXXXXX");
    expect(inv.buyer.vatId).toEqual({ country: "DE", code: "123456789" });
    expect(inv.buyer.address).toMatchObject({ postalCode: "00000", country: "DE" });
    expect(inv.buyer.address.province).toBeUndefined();
  });
  it("maps an individual to first/last name with a codice fiscale", () => {
    const d = doc();
    d.client = {
      type: "individual", displayName: "Mario Rossi", firstName: "Mario", lastName: "Rossi", taxCode: "rssmra80a01h501u",
      pecEmail: "mario@pec.it", billingAddress: { line1: "Via Dante 3", city: "Roma", region: "RM", postalCode: "00100", country: "IT" },
    };
    const b = mapDocument(d, seller, settings, ctx).body!.invoice.buyer;
    expect(b).toMatchObject({ firstName: "Mario", lastName: "Rossi", taxCode: "RSSMRA80A01H501U" });
    expect(b.name).toBeUndefined();
  });
});

describe("mapDocument — preflight errors", () => {
  it("flags missing seller/buyer fiscal data and bad addresses", () => {
    const d = doc();
    d.client.vatNumber = null;
    d.client.billingAddress = { line1: "Via X 1", city: "Milano", region: "Lombardia", postalCode: "2012" };
    const r = mapDocument(d, { ...seller, vatNumber: null }, settings, ctx);
    expect(codes(r)).toEqual(expect.arrayContaining(["business.vat_missing", "client.tax_id_missing", "client.postal_code_invalid", "client.province_missing"]));
  });
  it("flags numbers over 20 chars and a 0% line with no Natura", () => {
    const d = doc({ number: "1234567890123456789/2026", lines: [line({ taxRate: 0, lineTaxMinor: 0, lineTotalMinor: 100000 })] });
    expect(codes(mapDocument(d, seller, settings, ctx))).toEqual(expect.arrayContaining(["invoice.number_too_long", "invoice.nature_missing"]));
  });
  it("blocks when per-line tax rounding drifts more than a cent from the group total", () => {
    const lines = Array.from({ length: 10 }, () => line({ quantity: 1, unitPriceMinor: 5, lineSubtotalMinor: 5, lineTaxMinor: 1, lineTotalMinor: 6 }));
    // 10 × round(5 × 22%) = 10 × 1 = 10 cents, but round(50 × 22%) = 11 → drift 1 → still ok
    expect(mapDocument(doc({ lines }), seller, settings, ctx).ok).toBe(true);
    const lines2 = Array.from({ length: 30 }, () => line({ quantity: 1, unitPriceMinor: 5, lineSubtotalMinor: 5, lineTaxMinor: 1, lineTotalMinor: 6 }));
    // 30 cents vs round(150 × 22%) = 33 → drift 3 → blocked
    expect(codes(mapDocument(doc({ lines: lines2 }), seller, settings, ctx))).toContain("invoice.tax_rounding");
  });
});

describe("mapDocument — discounts, exempt lines and stamp duty", () => {
  it("bakes the line discount into the net unit price", () => {
    const l = line({ quantity: 3, unitPriceMinor: 10000, discountRate: 10, lineSubtotalMinor: 30000, lineDiscountMinor: 3000, lineTaxMinor: 5940, lineTotalMinor: 32940 });
    const inv = mapDocument(doc({ lines: [l], grandTotalMinor: 32940 }), seller, settings, ctx).body!.invoice;
    expect(inv.lines[0]).toMatchObject({ quantity: "3.00", unitPrice: "90.00", totalPrice: "270.00" });
    expect(inv.summaries[0]).toMatchObject({ taxableAmount: "270.00", taxAmount: "59.40" });
  });
  it("adds stampDuty when exempt (N2.2) amounts exceed 77.47, not when below or when off", () => {
    const exempt = (cents: number) => line({ taxRate: 0, nature: "N2.2", quantity: 1, unitPriceMinor: cents, lineSubtotalMinor: cents, lineTaxMinor: 0, lineTotalMinor: cents });
    const over = mapDocument(doc({ lines: [exempt(10000)], grandTotalMinor: 10000 }), seller, settings, ctx);
    expect(over.body!.invoice.stampDuty).toEqual({ virtual: true, amount: "2.00" });
    expect(over.bolloMinor).toBe(200);
    expect(mapDocument(doc({ lines: [exempt(7747)] }), seller, settings, ctx).body!.invoice.stampDuty).toBeUndefined();
    expect(mapDocument(doc({ lines: [exempt(10000)] }), seller, { ...settings, bollo: { ...settings.bollo, mode: "off" } }, ctx).body!.invoice.stampDuty).toBeUndefined();
  });
  it("does not count reverse-charge (N6.x) towards bollo, and uses the default Natura + law reference", () => {
    const l = line({ taxRate: 0, quantity: 1, unitPriceMinor: 50000, lineSubtotalMinor: 50000, lineTaxMinor: 0, lineTotalMinor: 50000 });
    const r = mapDocument(doc({ lines: [l], grandTotalMinor: 50000 }), seller, { ...settings, defaultZeroRateNature: "N6.3", zeroRateLawReference: "art. 17 DPR 633/72" }, ctx);
    expect(r.body!.invoice.stampDuty).toBeUndefined();
    expect(r.body!.invoice.summaries[0]).toMatchObject({ nature: "N6.3", lawReference: "art. 17 DPR 633/72" });
  });
});

describe("mapDocument — regime-implied Natura (forfettari)", () => {
  const zero = (q = 1, p = 50000) => line({ taxRate: 0, quantity: q, unitPriceMinor: p, lineSubtotalMinor: q * p, lineTaxMinor: 0, lineTotalMinor: q * p });
  it("RF19: 0% lines get N2.2 + the law reference without any configuration (and bollo applies above the threshold)", () => {
    const r = mapDocument(doc({ lines: [zero()], grandTotalMinor: 50000 }), seller, { ...settings, taxRegime: "RF19" }, ctx);
    expect(r.ok).toBe(true);
    const inv = r.body!.invoice;
    expect(inv.lines[0]).toMatchObject({ vatRate: "0.00", nature: "N2.2" });
    expect(inv.summaries[0]).toMatchObject({ nature: "N2.2" });
    expect(inv.summaries[0]!.lawReference).toContain("190/2014");
    expect(inv.stampDuty).toEqual({ virtual: true, amount: "2.00" });
  });
  it("an explicit line nature or account default still wins over the regime default", () => {
    const withLine = mapDocument(doc({ lines: [{ ...zero(), nature: "N4" }] }), seller, { ...settings, taxRegime: "RF19" }, ctx);
    expect(withLine.body!.invoice.lines[0]!.nature).toBe("N4");
    const withDefault = mapDocument(doc({ lines: [zero()] }), seller, { ...settings, taxRegime: "RF19", defaultZeroRateNature: "N2.1", zeroRateLawReference: "art. 7-ter" }, ctx);
    expect(withDefault.body!.invoice.lines[0]!.nature).toBe("N2.1");
    expect(withDefault.body!.invoice.summaries[0]!.lawReference).toBe("art. 7-ter");
  });
  it("ordinary regime (RF01) with a 0% line and no Natura still asks the user", () => {
    expect(mapDocument(doc({ lines: [zero()] }), seller, settings, ctx).issues.map((i) => i.code)).toContain("invoice.nature_missing");
  });
});

describe("mapDocument — credit notes", () => {
  it("emits TD04 with a distinct prefixed number, positive amounts, no payment block and the credited reference", () => {
    const d = doc({ kind: "credit_note", number: "1/2026", creditedNumber: "42/2026", creditedDate: "2026-09-01" });
    const inv = mapDocument(d, seller, settings, ctx).body!.invoice;
    expect(inv).toMatchObject({ documentType: "TD04", number: "NC 1/2026" });
    expect(inv.payment).toBeUndefined();
    expect(inv.lines[0]!.description).toContain("rif. fattura n. 42/2026 del 2026-09-01");
    expect(inv.lines[0]!.totalPrice).toBe("1000.00");
  });
});

describe("helpers", () => {
  it("splitVat strips a country prefix only when present", () => {
    expect(splitVat("IT 012.345.678-90", "IT")).toEqual({ country: "IT", code: "01234567890" });
    expect(splitVat("01234567890", "IT")).toEqual({ country: "IT", code: "01234567890" });
    expect(splitVat("fr12345678901", "DE")).toEqual({ country: "FR", code: "12345678901" });
    expect(splitVat("", "IT")).toBeNull();
  });
  it("splitStreet separates a trailing house number only", () => {
    expect(splitStreet("Via Roma 12")).toEqual({ street: "Via Roma", streetNumber: "12" });
    expect(splitStreet("Via Roma 12/B")).toEqual({ street: "Via Roma", streetNumber: "12/B" });
    expect(splitStreet("Via IV Novembre")).toEqual({ street: "Via IV Novembre" });
    expect(splitStreet("Via Roma")).toEqual({ street: "Via Roma" });
  });
});

describe("toFatturaText (XSD allows only Basic Latin + Latin-1)", () => {
  it("keeps Latin-1, maps typographic characters and strips the rest", () => {
    expect(toFatturaText("Perché è già così – « ok »")).toBe("Perché è già così - « ok »");
    expect(toFatturaText("Canone ‘mensile’ “2026”… 50€")).toBe("Canone 'mensile' \"2026\"... 50EUR");
    expect(toFatturaText("Łódź ő ✓ 😀 done")).toBe("Lódz o done");
    expect(toFatturaText("riga1\nriga2\t\u0000x")).toBe("riga1 riga2 x");
  });
  it("is applied to descriptions, names and addresses in the mapped body", () => {
    const d = doc({ lines: [line({ description: "Servizio – fase 1 ✓" })] });
    d.client.legalName = "Cliente – S.p.A.";
    const inv = mapDocument(d, seller, settings, ctx).body!.invoice;
    expect(inv.lines[0]!.description).toBe("Servizio - fase 1");
    expect(inv.buyer.name).toBe("Cliente - S.p.A.");
  });
});
