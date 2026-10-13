/**
 * FatturaPA code lists used by the e-invoicing integration.
 *
 * Browser-safe (no Node imports) and exposed as the `@billy/einvoice/codes`
 * subpath, so the web app can import it without pulling the package barrel.
 * Human labels live in the web locale catalogs, keyed `einvoicing.codes.<list>.<code>`.
 */

/** RegimeFiscale — the seller's tax regime. (RF03 does not exist.) */
export const TAX_REGIMES = [
  "RF01", "RF02", "RF04", "RF05", "RF06", "RF07", "RF08", "RF09", "RF10",
  "RF11", "RF12", "RF13", "RF14", "RF15", "RF16", "RF17", "RF18", "RF19",
] as const;
export type TaxRegime = (typeof TAX_REGIMES)[number];

/** ModalitaPagamento. */
export const PAYMENT_METHODS = [
  "MP01", "MP02", "MP03", "MP04", "MP05", "MP06", "MP07", "MP08", "MP09", "MP10", "MP11", "MP12",
  "MP13", "MP14", "MP15", "MP16", "MP17", "MP18", "MP19", "MP20", "MP21", "MP22", "MP23",
] as const;
export type PaymentMethodCode = (typeof PAYMENT_METHODS)[number];

/** CondizioniPagamento. */
export const PAYMENT_CONDITIONS = ["TP01", "TP02", "TP03"] as const;
export type PaymentConditionCode = (typeof PAYMENT_CONDITIONS)[number];

/** Natura — why a line has 0% VAT. */
export const NATURA_CODES = [
  "N1", "N2.1", "N2.2", "N3.1", "N3.2", "N3.3", "N3.4", "N3.5", "N3.6", "N4", "N5",
  "N6.1", "N6.2", "N6.3", "N6.4", "N6.5", "N6.6", "N6.7", "N6.8", "N6.9", "N7",
] as const;
export type NaturaCode = (typeof NATURA_CODES)[number];

/** TipoDocumento values billy can emit. */
export type DocumentTypeCode = "TD01" | "TD04";

/** Natura codes whose amounts count towards the stamp-duty threshold (exempt / excluded operations). */
export const BOLLO_NATURE_CODES: ReadonlySet<string> = new Set(["N1", "N2.1", "N2.2", "N3.5", "N3.6", "N4"]);

/**
 * The Natura (and the law reference printed with it) that follows from the seller's tax regime
 * alone, so those accounts never have to configure it: a forfettario (RF19) charges no VAT on
 * anything, under art. 1, commi 54-89, L. 190/2014 (Natura N2.2).
 */
export const REGIME_IMPLIED_ZERO_RATE: Partial<Record<TaxRegime, { nature: NaturaCode; lawReference: string }>> = {
  RF19: { nature: "N2.2", lawReference: "Operazione senza applicazione dell'IVA ai sensi dell'art. 1, commi 54-89, L. 190/2014 (regime forfettario)" },
};

/** Natura for the stamp-duty charge-back line (art. 15 DPR 633/72: excluded from VAT base). */
export const BOLLO_LINE_NATURA: NaturaCode = "N1";
/** Legal defaults for imposta di bollo on invoices (DPR 642/1972). */
export const BOLLO_DEFAULT_THRESHOLD = "77.47";
export const BOLLO_DEFAULT_AMOUNT = "2.00";

/** Default transmission deadline in days from the invoice date (art. 21 DPR 633/72). */
export const DEFAULT_SEND_DEADLINE_DAYS = 12;

/** `XXXXXXX` — destination code for a buyer resident outside Italy. */
export const FOREIGN_RECIPIENT_CODE = "XXXXXXX";
/** `0000000` — destination code when the buyer is reached by PEC or is a consumer. */
export const NO_RECIPIENT_CODE = "0000000";

const asSet = <T extends string>(xs: readonly T[]): ReadonlySet<string> => new Set<string>(xs);
const TAX_REGIME_SET = asSet(TAX_REGIMES);
const PAYMENT_METHOD_SET = asSet(PAYMENT_METHODS);
const NATURA_SET = asSet(NATURA_CODES);

export const isTaxRegime = (v: unknown): v is TaxRegime => typeof v === "string" && TAX_REGIME_SET.has(v);
export const isPaymentMethodCode = (v: unknown): v is PaymentMethodCode => typeof v === "string" && PAYMENT_METHOD_SET.has(v);
export const isNaturaCode = (v: unknown): v is NaturaCode => typeof v === "string" && NATURA_SET.has(v);

/** Italian SDI destination code: 7 chars for private recipients, 6 for public administration. */
export const isValidRecipientCode = (v: unknown): boolean => typeof v === "string" && /^[A-Z0-9]{6,7}$/u.test(v);
