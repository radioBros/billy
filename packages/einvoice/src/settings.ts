import {
  BOLLO_DEFAULT_AMOUNT,
  BOLLO_DEFAULT_THRESHOLD,
  DEFAULT_SEND_DEADLINE_DAYS,
  type NaturaCode,
  type PaymentConditionCode,
  type PaymentMethodCode,
  type TaxRegime,
} from "./codes.js";
import type { MapperSettings } from "./types.js";
import type { EInvoiceStatus } from "./status.js";

/** Stored per-account settings (`settings` collection, key `einvoicing`). Secrets are ciphertext. */
export interface EInvoicingSettingsData {
  enabled: boolean;
  mode: "managed" | "manual";
  apiBaseUrl?: string | null;
  passoTenantId?: string | null;
  passoSellerId?: string | null;
  /** Human-readable labels for the PASSO tenant / seller (the ids are opaque UUIDs). */
  passoTenantName?: string | null;
  passoSellerName?: string | null;
  /** AES-256-GCM ciphertext of the PASSO tenant API key (never returned). */
  apiKeyEnc?: string | null;
  apiKeyLast4?: string | null;
  webhookId?: string | null;
  /** AES-256-GCM ciphertext of the PASSO webhook signing secret (never returned). */
  webhookSecretEnc?: string | null;
  /** Last passing PEC test (HMAC of the tested config; the password itself is never stored). */
  pecTest?: { hash: string; at: string; to: string } | null;
  /** Last passing OpenAPI.it connection test (keyed hash of token+host+signing; the token is never stored here). */
  openapiTest?: { hash: string; at: string } | null;
  webhookMode: "webhook" | "poll";
  webhookReason?: string | null;
  /** Channel type + NON-secret config only (PASSO replaces whole config on PUT). */
  channel?: {
    type: "pec" | "openapi" | "mock";
    configuredAt: string;
    publicConfig: Record<string, string | number | boolean>;
  } | null;
  taxRegime: TaxRegime;
  offerStepAfterFinalize: boolean;
  scheduledDefaultSubmit: boolean;
  recurringDefaultSubmit: boolean;
  defaultPaymentConditions: PaymentConditionCode;
  defaultPaymentMethod: PaymentMethodCode;
  defaultZeroRateNature?: NaturaCode | null;
  zeroRateLawReference?: string | null;
  bollo: { mode: "auto" | "off"; threshold: string; amount: string };
  creditNoteNumberPrefix: string;
  sendDeadlineDays: number;
  enabledAt?: string | null;
  lastHealth?: { ok: boolean; checkedAt: string; message?: string | null } | null;
}

export const DEFAULT_EINVOICING_SETTINGS: EInvoicingSettingsData = {
  enabled: false,
  mode: "managed",
  webhookMode: "poll",
  taxRegime: "RF01",
  offerStepAfterFinalize: true,
  scheduledDefaultSubmit: true,
  recurringDefaultSubmit: true,
  defaultPaymentConditions: "TP02",
  defaultPaymentMethod: "MP05",
  bollo: { mode: "auto", threshold: BOLLO_DEFAULT_THRESHOLD, amount: BOLLO_DEFAULT_AMOUNT },
  creditNoteNumberPrefix: "NC",
  sendDeadlineDays: DEFAULT_SEND_DEADLINE_DAYS,
};

/** Defaults are only written on insert, so readers must merge them over any stored doc. */
export const normalizeEInvoicingSettings = (stored: Partial<EInvoicingSettingsData> | null | undefined): EInvoicingSettingsData => ({
  ...DEFAULT_EINVOICING_SETTINGS,
  ...(stored ?? {}),
  bollo: { ...DEFAULT_EINVOICING_SETTINGS.bollo, ...(stored?.bollo ?? {}) },
});

export const toMapperSettings = (s: EInvoicingSettingsData): MapperSettings => ({
  taxRegime: s.taxRegime,
  defaultPaymentConditions: s.defaultPaymentConditions,
  defaultPaymentMethod: s.defaultPaymentMethod,
  defaultZeroRateNature: s.defaultZeroRateNature ?? null,
  zeroRateLawReference: s.zeroRateLawReference ?? null,
  bollo: s.bollo,
  creditNoteNumberPrefix: s.creditNoteNumberPrefix,
});

/** Connected = PASSO URL + tenant API key + seller id present. */
export const isConnected = (s: EInvoicingSettingsData, envApiUrl?: string | null): boolean =>
  Boolean((s.apiBaseUrl || envApiUrl) && s.apiKeyEnc && s.passoSellerId);

/** Per-document e-invoice state, stored on the invoice / credit note as `einvoice`. */
export interface EInvoiceDocState {
  status: EInvoiceStatus;
  legallyIssued: boolean;
  /** Scheduled invoice / recurring occurrence: submit as soon as it is finalized. */
  submitOnFinalize?: boolean;
  currentSubmissionId?: string | null;
  identificativoSdI?: string | null;
  fileName?: string | null;
  submittedAt?: string | null;
  lastEventAt?: string | null;
  lastError?: { code: string; message: string } | null;
}

/** One row per PASSO submission (collection `einvoiceSubmissions`). */
export interface EInvoiceSubmissionDoc {
  id: string;
  accountId: string;
  docKind: "invoice" | "credit_note";
  docId: string;
  attempt: number;
  idempotencyKey: string;
  passoSubmissionId: string;
  progressivoInvio?: string | null;
  fileName?: string | null;
  channelRef?: string | null;
  payloadSha256?: string | null;
  status: EInvoiceStatus;
  trigger: string;
  receipts: { type: string; receivedAt: string; errors?: { code: string; description?: string; remedy?: string }[]; ackedAt?: string | null }[];
  /** FatturaPA XML archived right after acceptance (PASSO purges its copy after the final receipt). */
  xml?: string | null;
  xmlSha256?: string | null;
  archivedAt?: string | null;
  /** Next time the sync sweep should poll this submission; null once `pollingDone`. */
  nextSyncAt?: string | null;
  pollingDone?: boolean;
  lastError?: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}
