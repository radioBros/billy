import type { NaturaCode, PaymentConditionCode, PaymentMethodCode, TaxRegime } from "./codes.js";

/** Plain-data inputs so the mapper stays pure and shared by api, worker and tests. */

export interface SourceAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export interface SourceClient {
  type?: string | null;
  displayName: string;
  legalName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  vatNumber?: string | null;
  taxCode?: string | null;
  recipientCode?: string | null;
  pecEmail?: string | null;
  country?: string | null;
  billingAddress?: SourceAddress | null;
}

export interface SourceLine {
  description: string;
  quantity: number;
  unitPriceMinor: number;
  discountRate?: number;
  taxRate?: number;
  /** Natura, required (here or via settings default) when the rate is 0. */
  nature?: string | null;
  lineSubtotalMinor: number;
  lineDiscountMinor: number;
  lineTaxMinor: number;
  lineTotalMinor: number;
}

export interface SourceDocument {
  kind: "invoice" | "credit_note";
  /** Number as shown by billy (`12/2026`). */
  number: string;
  issueDate: string;
  dueDate?: string | null;
  currency: string;
  lines: SourceLine[];
  grandTotalMinor: number;
  client: SourceClient;
  /** IBAN of the bank account snapshotted on the document, if structured. */
  iban?: string | null;
  /** Credit notes: number/date of the credited invoice (printed in the first line's text). */
  creditedNumber?: string | null;
  creditedDate?: string | null;
}

export interface SourceSeller {
  name: string;
  vatNumber?: string | null;
  taxCode?: string | null;
  address?: SourceAddress | null;
}

export interface MapperSettings {
  taxRegime: TaxRegime;
  defaultPaymentConditions: PaymentConditionCode;
  defaultPaymentMethod: PaymentMethodCode;
  defaultZeroRateNature?: NaturaCode | null;
  zeroRateLawReference?: string | null;
  bollo: { mode: "auto" | "off"; threshold: string; amount: string };
  /** Prefix for credit-note numbers in the XML (PASSO forbids repeating a number). */
  creditNoteNumberPrefix: string;
}

export type IssueSeverity = "error" | "warning";
export interface PreflightIssue {
  /** Stable machine key, also the i18n suffix: `einvoicing.issues.<code>`. */
  code: string;
  severity: IssueSeverity;
  /** Where the user fixes it. */
  fix: "client" | "business" | "settings" | "invoice" | "none";
  /** Interpolation values for the message. */
  params?: Record<string, string | number>;
}

/** PASSO request body (subset PASSO accepts; all money as decimal strings). */
export interface PassoParty {
  vatId?: { country: string; code: string };
  taxCode?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  address: {
    street: string;
    streetNumber?: string;
    postalCode: string;
    city: string;
    province?: string;
    country: string;
  };
  taxRegime?: string;
}
export interface PassoLine {
  lineNumber: number;
  description: string;
  quantity: string;
  unitPrice: string;
  totalPrice: string;
  vatRate: string;
  nature?: string;
}
export interface PassoSummary {
  vatRate: string;
  nature?: string;
  taxableAmount: string;
  taxAmount: string;
  vatCollectability: "I";
  lawReference?: string;
}
export interface PassoInvoice {
  documentType: "TD01" | "TD04";
  number: string;
  date: string;
  currency: string;
  format: "FPR12";
  recipientCode: string;
  recipientPec?: string;
  seller: PassoParty;
  buyer: PassoParty;
  lines: PassoLine[];
  summaries: PassoSummary[];
  stampDuty?: { virtual: true; amount: string };
  payment?: {
    conditions: string;
    method: string;
    dueDate?: string;
    amount: string;
    iban?: string;
  };
}
export interface PassoSubmitBody {
  sellerId: string;
  crmInvoiceRef: string;
  mode: "async";
  invoice: PassoInvoice;
}
