import {
  FOREIGN_RECIPIENT_CODE,
  NO_RECIPIENT_CODE,
  BOLLO_NATURE_CODES,
  REGIME_IMPLIED_ZERO_RATE,
  isNaturaCode,
  isValidRecipientCode,
} from "./codes.js";
import { decimalToMinor, minorToDecimal, numberToDecimal, rateToDecimal, roundMinor } from "./money.js";
import type {
  MapperSettings,
  PassoInvoice,
  PassoLine,
  PassoParty,
  PassoSubmitBody,
  PassoSummary,
  PreflightIssue,
  SourceAddress,
  SourceDocument,
  SourceSeller,
} from "./types.js";

export interface MapResult {
  /** Present only when there are no error-severity issues. */
  body: PassoSubmitBody | null;
  issues: PreflightIssue[];
  ok: boolean;
  /** Whether stamp duty applies (so the UI can show it even when blocked). */
  bolloMinor: number;
}

const MAX_NUMBER = 20;

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

const TRANSLIT: Record<string, string> = {
  "\u2013": "-", "\u2014": "-", "\u2212": "-", "\u2018": "'", "\u2019": "'", "\u201A": ",", "\u201C": '"', "\u201D": '"',
  "\u2026": "...", "\u20AC": "EUR", "\u2022": "-", "\u00A0": " ", "\u2122": "", "\u2713": "", "\u2714": "",
  // Letters with no NFD decomposition.
  "\u0141": "L", "\u0142": "l", "\u0110": "D", "\u0111": "d", "\u0152": "OE", "\u0153": "oe", "\u0131": "i",
};
/**
 * FatturaPA text fields only accept Basic Latin + Latin-1 Supplement (XSD pattern). Map common
 * typographic characters, strip diacritics from other Latin letters (Ł→L, ő→o), drop the rest and
 * flatten line breaks, so a stray "–" or emoji never makes SdI reject the invoice.
 */
export const toFatturaText = (s: string): string => {
  let out = "";
  for (const ch of s.normalize("NFC")) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x0A || cp === 0x0D || cp === 0x09) out += " ";
    else if (cp < 0x20 || cp === 0x7F) continue;
    else if (cp <= 0xFF) out += ch;
    else if (TRANSLIT[ch] !== undefined) out += TRANSLIT[ch];
    else out += ch.normalize("NFD").replace(/[^\u0020-\u00FF]/gu, "");
  }
  return out.replace(/ {2,}/gu, " ").trim();
};

/** Split an optional ISO-3166 alpha-2 prefix off a VAT number (`IT0123…` → IT + `0123…`). */
export const splitVat = (raw: string, fallbackCountry: string): { country: string; code: string } | null => {
  const v = raw.replace(/[\s.\-]/gu, "").toUpperCase();
  if (!v) return null;
  const m = /^([A-Z]{2})([A-Z0-9]+)$/u.exec(v);
  const hasPrefix = m !== null && /[A-Z]/u.test(v.slice(0, 2)) && !/^\d/u.test(v);
  const country = hasPrefix ? m[1]! : fallbackCountry;
  const code = hasPrefix ? m[2]! : v;
  if (!/^[A-Z0-9]{1,28}$/u.test(code)) return null;
  return { country, code };
};

/** `Via Roma 12` → street `Via Roma`, number `12`. Leaves the text alone when it doesn't clearly end in a number. */
export const splitStreet = (line1: string): { street: string; streetNumber?: string } => {
  const m = /^(.*\S)\s+(\d+[A-Za-z]?(?:[/\-][A-Za-z0-9]{1,3})?)$/u.exec(line1.trim());
  if (m && m[2]!.length <= 8) return { street: m[1]!, streetNumber: m[2]! };
  return { street: line1.trim() };
};

const mapAddress = (
  a: SourceAddress | null | undefined,
  fallbackCountry: string,
  who: "client" | "business",
  issues: PreflightIssue[],
): PassoParty["address"] | null => {
  const line1 = (a?.line1 ?? "").trim();
  const city = (a?.city ?? "").trim();
  if (!line1 || !city) {
    issues.push({ code: `${who}.address_incomplete`, severity: "error", fix: who });
    return null;
  }
  const country = (a?.country ?? fallbackCountry ?? "IT").trim().toUpperCase().slice(0, 2) || "IT";
  const italian = country === "IT";
  let postalCode = (a?.postalCode ?? "").trim();
  if (italian && !/^\d{5}$/u.test(postalCode)) {
    issues.push({ code: `${who}.postal_code_invalid`, severity: "error", fix: who });
    postalCode = "00000";
  }
  if (!italian) postalCode = "00000"; // PASSO wants exactly five digits; foreign buyers use 00000
  const region = (a?.region ?? "").trim().toUpperCase();
  const province = /^[A-Z]{2}$/u.test(region) ? region : undefined;
  if (italian && !province) issues.push({ code: `${who}.province_missing`, severity: "error", fix: who });
  const { street, streetNumber } = splitStreet(line1);
  return {
    street: clip(toFatturaText(street), 60),
    ...(streetNumber ? { streetNumber } : {}),
    postalCode,
    city: clip(toFatturaText(city), 60),
    ...(province && italian ? { province } : {}),
    country,
  };
};

export interface MapContext {
  passoSellerId: string;
  /** Opaque reference echoed by PASSO and kept after purge. */
  crmInvoiceRef: string;
}

export const mapDocument = (
  doc: SourceDocument,
  seller: SourceSeller,
  settings: MapperSettings,
  ctx: MapContext,
): MapResult => {
  const issues: PreflightIssue[] = [];
  const err = (code: string, fix: PreflightIssue["fix"], params?: PreflightIssue["params"]): void => {
    issues.push({ code, severity: "error", fix, ...(params ? { params } : {}) });
  };

  const isCredit = doc.kind === "credit_note";
  // PASSO refuses repeating a number for the same seller, and billy numbers credit notes in
  // their own series, so credit notes get a distinct e-invoice number.
  const xmlNumber = isCredit ? `${settings.creditNoteNumberPrefix} ${doc.number}`.trim() : doc.number;
  if (!doc.number) err("invoice.number_missing", "invoice");
  if (xmlNumber.length > MAX_NUMBER) err("invoice.number_too_long", "invoice", { max: MAX_NUMBER });
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(doc.issueDate)) err("invoice.date_invalid", "invoice");
  if (doc.lines.length === 0) err("invoice.no_lines", "invoice");

  // ── Seller ────────────────────────────────────────────────────────────────
  const sellerVat = seller.vatNumber ? splitVat(seller.vatNumber, "IT") : null;
  if (!sellerVat) err("business.vat_missing", "business");
  if (!seller.name.trim()) err("business.name_missing", "business");
  const sellerAddress = mapAddress(seller.address, "IT", "business", issues);
  const passoSeller: PassoParty = {
    ...(sellerVat ? { vatId: sellerVat } : {}),
    ...(seller.taxCode ? { taxCode: seller.taxCode.trim().toUpperCase() } : {}),
    name: clip(toFatturaText(seller.name), 80),
    address: sellerAddress ?? { street: "-", postalCode: "00000", city: "-", country: "IT" },
    taxRegime: settings.taxRegime,
  };

  // ── Buyer + routing ───────────────────────────────────────────────────────
  const c = doc.client;
  const clientCountry = (c.billingAddress?.country ?? c.country ?? "IT").trim().toUpperCase().slice(0, 2) || "IT";
  const italianBuyer = clientCountry === "IT";
  const individual = c.type === "individual";
  const buyerVat = c.vatNumber ? splitVat(c.vatNumber, clientCountry) : null;
  const buyerTaxCode = c.taxCode?.trim().toUpperCase() || undefined;
  if (!buyerVat && !buyerTaxCode) err("client.tax_id_missing", "client");
  const buyerAddress = mapAddress(c.billingAddress, clientCountry, "client", issues);

  const buyer: PassoParty = {
    ...(buyerVat ? { vatId: buyerVat } : {}),
    ...(buyerTaxCode ? { taxCode: buyerTaxCode } : {}),
    address: buyerAddress ?? { street: "-", postalCode: "00000", city: "-", country: clientCountry },
  };
  if (individual) {
    const fn = (c.firstName ?? "").trim();
    const ln = (c.lastName ?? "").trim();
    if (!fn || !ln) err("client.person_name_missing", "client");
    buyer.firstName = clip(toFatturaText(fn), 60);
    buyer.lastName = clip(toFatturaText(ln), 60);
  } else {
    const nm = (c.legalName ?? c.displayName ?? "").trim();
    if (!nm) err("client.name_missing", "client");
    buyer.name = clip(toFatturaText(nm), 80);
  }

  let recipientCode: string;
  let recipientPec: string | undefined;
  const code = (c.recipientCode ?? "").trim().toUpperCase();
  const pec = (c.pecEmail ?? "").trim();
  if (!italianBuyer) {
    recipientCode = FOREIGN_RECIPIENT_CODE;
  } else if (code && code !== NO_RECIPIENT_CODE) {
    if (!isValidRecipientCode(code)) err("client.recipient_code_invalid", "client");
    if (code.length === 6) err("client.public_administration_unsupported", "client");
    recipientCode = code;
  } else if (pec) {
    recipientCode = NO_RECIPIENT_CODE;
    recipientPec = pec;
  } else {
    // PASSO rejects 0000000 without a PEC (consumers cannot be sent yet).
    err("client.routing_missing", "client");
    recipientCode = NO_RECIPIENT_CODE;
  }

  // ── Lines + summaries ─────────────────────────────────────────────────────
  const lines: PassoLine[] = [];
  interface Group { rate: number; nature?: string; taxable: number; tax: number }
  const groups = new Map<string, Group>();
  let zeroRateTaxable = 0;
  doc.lines.forEach((l, i) => {
    const rate = l.taxRate ?? 0;
    const net = l.lineSubtotalMinor - l.lineDiscountMinor;
    let nature: string | undefined;
    if (rate === 0) {
      // Line > account default > what the tax regime implies (forfettari: N2.2) > ask the user.
      nature = (l.nature || settings.defaultZeroRateNature || REGIME_IMPLIED_ZERO_RATE[settings.taxRegime]?.nature || undefined) ?? undefined;
      if (!nature) err("invoice.nature_missing", "invoice", { line: i + 1 });
      else if (!isNaturaCode(nature)) err("invoice.nature_invalid", "invoice", { line: i + 1 });
      if (nature && BOLLO_NATURE_CODES.has(nature)) zeroRateTaxable += net;
    }
    const qty = l.quantity === 0 ? 1 : l.quantity;
    // PASSO has no line-discount block, so the discount is baked into the net unit price.
    const unitNet = l.quantity === 0 ? net / 100 : net / 100 / qty;
    lines.push({
      lineNumber: i + 1,
      description: clip(
        toFatturaText(
          isCredit && i === 0 && doc.creditedNumber
            ? `${l.description} (rif. fattura n. ${doc.creditedNumber}${doc.creditedDate ? ` del ${doc.creditedDate}` : ""})`
            : l.description,
        ),
        1000,
      ),
      quantity: numberToDecimal(qty, 2, 8),
      unitPrice: numberToDecimal(unitNet, 2, 8),
      totalPrice: minorToDecimal(net),
      vatRate: rateToDecimal(rate),
      ...(nature ? { nature } : {}),
    });
    const key = `${rate}|${nature ?? ""}`;
    const g = groups.get(key) ?? { rate, ...(nature ? { nature } : {}), taxable: 0, tax: 0 };
    g.taxable += net;
    g.tax += l.lineTaxMinor;
    groups.set(key, g);
  });

  const summaries: PassoSummary[] = [];
  for (const g of groups.values()) {
    // The summary tax is the sum of the per-line rounded tax (what the PDF totals show).
    // SdI tolerates a one-cent difference from round(taxable × rate); beyond that it rejects.
    const expected = roundMinor((g.taxable * g.rate) / 100);
    if (Math.abs(expected - g.tax) > 1) err("invoice.tax_rounding", "invoice", { rate: g.rate });
    summaries.push({
      vatRate: rateToDecimal(g.rate),
      ...(g.nature ? { nature: g.nature } : {}),
      taxableAmount: minorToDecimal(g.taxable),
      taxAmount: minorToDecimal(g.tax),
      vatCollectability: "I",
      ...(g.rate === 0 && (settings.zeroRateLawReference || REGIME_IMPLIED_ZERO_RATE[settings.taxRegime]?.lawReference)
        ? { lawReference: clip(toFatturaText((settings.zeroRateLawReference || REGIME_IMPLIED_ZERO_RATE[settings.taxRegime]?.lawReference)!), 100) }
        : {}),
    });
  }

  // ── Stamp duty (bollo) ────────────────────────────────────────────────────
  // Due when amounts outside the VAT base exceed the threshold. Credit notes follow the invoice
  // they correct and carry none here.
  const thresholdMinor = decimalToMinor(settings.bollo.threshold);
  const bolloDue = !isCredit && settings.bollo.mode === "auto" && zeroRateTaxable > thresholdMinor;
  const bolloMinor = bolloDue ? decimalToMinor(settings.bollo.amount) : 0;

  // ── Payment ───────────────────────────────────────────────────────────────
  const iban = doc.iban?.replace(/\s+/gu, "").toUpperCase();
  const needsIban = settings.defaultPaymentMethod === "MP05" || settings.defaultPaymentMethod === "MP19";
  if (needsIban && !iban && !isCredit) {
    issues.push({ code: "invoice.iban_missing", severity: "warning", fix: "settings" });
  }
  const payment: PassoInvoice["payment"] = isCredit
    ? undefined
    : {
        conditions: settings.defaultPaymentConditions,
        method: settings.defaultPaymentMethod,
        ...(doc.dueDate ? { dueDate: doc.dueDate } : {}),
        amount: minorToDecimal(doc.grandTotalMinor),
        ...(iban && /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/u.test(iban) ? { iban } : {}),
      };

  const invoice: PassoInvoice = {
    documentType: isCredit ? "TD04" : "TD01",
    number: xmlNumber,
    date: doc.issueDate,
    currency: doc.currency,
    format: "FPR12",
    recipientCode,
    ...(recipientPec ? { recipientPec } : {}),
    seller: passoSeller,
    buyer,
    lines,
    summaries,
    ...(bolloMinor > 0 ? { stampDuty: { virtual: true as const, amount: minorToDecimal(bolloMinor) } } : {}),
    ...(payment ? { payment } : {}),
  };

  const ok = !issues.some((i) => i.severity === "error");
  return {
    ok,
    issues,
    bolloMinor,
    body: ok
      ? { sellerId: ctx.passoSellerId, crmInvoiceRef: ctx.crmInvoiceRef, mode: "async", invoice }
      : null,
  };
};
