import { writeFileSync } from "node:fs";
import { mapDocument } from "../../packages/einvoice/src/index.ts";

const settings = { taxRegime: "RF01", defaultPaymentConditions: "TP02", defaultPaymentMethod: "MP05", defaultZeroRateNature: null, zeroRateLawReference: null, bollo: { mode: "auto", threshold: "77.47", amount: "2.00" }, creditNoteNumberPrefix: "NC" } as const;
const seller = { name: "Fornitore S.r.l.", vatNumber: "IT01234567890", taxCode: "01234567890", address: { line1: "Via Roma 12", city: "Milano", region: "MI", postalCode: "20100", country: "IT" } };
const L = (q: number, p: number, rate: number, disc = 0, nature?: string) => {
  const sub = Math.round(q * p); const d = Math.round(sub * disc / 100); const net = sub - d; const tax = Math.round(net * rate / 100);
  return { description: "Servizio di prova", quantity: q, unitPriceMinor: p, discountRate: disc, taxRate: rate, nature, lineSubtotalMinor: sub, lineDiscountMinor: d, lineTaxMinor: tax, lineTotalMinor: net + tax };
};
const total = (ls: ReturnType<typeof L>[]) => ls.reduce((a, l) => a + l.lineTotalMinor, 0);
const company = { type: "company", displayName: "Cliente", legalName: "Cliente S.p.A.", vatNumber: "IT09876543210", recipientCode: "ABC1234", country: "IT", billingAddress: { line1: "Corso Buenos Aires 5", city: "Milano", region: "MI", postalCode: "20124", country: "IT" } };
const doc = (over: Record<string, unknown>, lines: ReturnType<typeof L>[]) => ({ kind: "invoice", number: "42/2026", issueDate: "2026-09-01", dueDate: "2026-10-01", currency: "EUR", iban: "IT60X0542811101000000123456", lines, grandTotalMinor: total(lines), client: company, ...over });

const cases: Record<string, unknown> = {
  b2b_22: doc({}, [L(10, 10000, 22)]),
  fractional_qty_discount: doc({}, [L(2.5, 3333, 22, 15), L(1, 999, 22)]),
  multi_rate: doc({}, [L(1, 10000, 22), L(3, 5000, 10), L(1, 7000, 4)]),
  pec_only: doc({ client: { ...company, recipientCode: null, pecEmail: "cliente@pec.it" } }, [L(1, 12345, 22)]),
  individual_with_pec: doc({ client: { type: "individual", displayName: "Mario Rossi", firstName: "Mario", lastName: "Rossi", taxCode: "RSSMRA80A01H501U", pecEmail: "mario@pec.it", billingAddress: { line1: "Via Dante 3/B", city: "Roma", region: "RM", postalCode: "00100", country: "IT" } } }, [L(1, 5000, 22)]),
  foreign_eu: doc({ client: { type: "company", displayName: "ACME GmbH", legalName: "ACME GmbH", vatNumber: "DE123456789", billingAddress: { line1: "Hauptstrasse 1", city: "Berlin", postalCode: "10115", country: "DE" } } }, [L(1, 20000, 0, 0, "N3.2")]),
  exempt_bollo: doc({}, [L(1, 15000, 0, 0, "N4")]),
  reverse_charge: doc({}, [L(1, 50000, 0, 0, "N6.3")]),
  mixed_vat_and_exempt: doc({}, [L(1, 10000, 22), L(1, 10000, 0, 0, "N2.2")]),
  credit_note: doc({ kind: "credit_note", number: "1/2026", creditedNumber: "42/2026", creditedDate: "2026-09-01" }, [L(1, 10000, 22)]),
  long_description_and_unicode: doc({}, [{ ...L(1, 100, 22), description: "Canone « mensile » – perché è già incluso ✓ ".repeat(8) }]),
};
const forf = { ...settings, taxRegime: "RF19" } as const;
const out: Record<string, unknown> = {};
const map = (d: unknown, s: unknown) => mapDocument(d as never, seller, s as never, { passoSellerId: "s", crmInvoiceRef: "r" });
{
  const r = map(doc({}, [L(1, 80000, 0)]), forf);
  out["forfettario_no_config"] = { ok: r.ok, issues: r.issues.map((i) => i.code), invoice: r.body?.invoice ?? null };
}
for (const [k, d] of Object.entries(cases)) {
  const r = mapDocument(d as never, seller, settings as never, { passoSellerId: "s", crmInvoiceRef: "r" });
  out[k] = { ok: r.ok, issues: r.issues.map((i) => i.code), invoice: r.body?.invoice ?? null };
}
writeFileSync(process.argv[2]!, JSON.stringify(out, null, 2));
