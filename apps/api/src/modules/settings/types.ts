import type { BaseDoc } from "@billy/types";
import type { AddressInput } from "@billy/validation";
import type { LocalizedText } from "@billy/shared";

/**
 * Settings module entities. Two distinct stores:
 *
 *  - **Global business settings** — a *singleton* document per group, written only
 *    with `canManageSettings`. Stored in the `settings` collection keyed by a fixed
 *    `key` ("business" | "tax" | "numbering"); single-tenant, so there is exactly
 *    one row per key. Carries the BaseDoc mixin (`version`/timestamps) for shape
 *    consistency and future optimistic-concurrency.
 *  - **Per-user UI settings** — one `UserSettings` per user,
 *    self-scoped via `/me/settings`, keyed strictly by `userId`. Kept lean (the
 *    prefs shape + audit timestamps), NOT a full BaseDoc entity.
 *
 * Invoicing/email/data/push settings groups are out of scope for
 * this module — handled by other modules.
 */

export type SettingsKey =
  | "business"
  | "tax"
  | "numbering"
  | "branding"
  | "email"
  | "localization"
  | "documents"
  | "toggles";

export const SETTINGS_KEYS: readonly SettingsKey[] = [
  "business",
  "tax",
  "numbering",
  "branding",
  "email",
  "localization",
  "documents",
  "toggles",
] as const;

// ── Business settings ────────────────────────────────────────────────────────

/**
 * A single named bank account (multi-bank). `details` is freeform multiline text
 * (a textarea value) copied verbatim onto an invoice's `bankSnapshot` at create.
 */
export interface BankAccount {
  id: string;
  label: string;
  details: string;
}

/** Domain fields of the business-settings singleton. */
export interface BusinessSettingsData {
  businessName: string;
  legalName?: string | null;
  vatNumber?: string | null;
  taxCode?: string | null;
  address?: AddressInput | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  logoFileId?: string | null;
  defaultCurrency: string; // ISO 4217, the base currency
  defaultLanguage: "en" | "es" | "it" | "fr" | "ru" | "pt" | "de";
  timezone: string; // IANA
  defaultPaymentTermsDays: number;
  defaultTaxRate: number; // percentage, 0..100
  /** Named bank accounts (multi-bank). Empty by default; snapshotted onto invoices at create. */
  bankAccounts: BankAccount[];
  /** Per-language free-text (or legacy plain string). Resolved to a string at the document-render boundary. */
  invoiceFooter?: LocalizedText;
  /** Per-language free-text (or legacy plain string). Resolved to a string at the document-render boundary. */
  quoteFooter?: LocalizedText;
}

// ── Tax settings — reusable rates, no full tax accounting ────

export interface TaxRate {
  id: string;
  label: string;
  rate: number; // percentage, 0..100 (0 = zero-rate)
  isDefault?: boolean;
  zeroRateLabel?: string | null;
}

/** Domain fields of the tax-settings singleton. */
export interface TaxSettingsData {
  rates: TaxRate[];
  pricesIncludeTax: boolean; // tax-inclusive vs tax-exclusive
  perLineTax: boolean;
  exemptionNote?: string | null;
}

// ── Numbering settings — counter config only ────────────────

/** Per-series numbering configuration. Allocation owned by invoices. */
export interface NumberingSeries {
  prefix: string; // e.g. "Q-", "INV-", "CN-", "PRO-"
  startNumber: number;
  padding: number; // zero-pad width, e.g. 4 → "0001"
  yearlyReset: boolean;
}

/** Domain fields of the numbering-settings singleton. */
export interface NumberingSettingsData {
  quote: NumberingSeries;
  invoice: NumberingSeries;
  creditNote: NumberingSeries;
  proforma: NumberingSeries;
}

// ── Customization: Branding ──────────────────────────

/** Domain fields of the branding-settings singleton. */
export interface BrandingSettingsData {
  appName: string;
  logoFileId?: string | null;
  faviconFileId?: string | null;
  primaryColor: string; // hex, applied to the Vuetify theme at runtime
  secondaryColor: string;
  accentColor: string;
  defaultThemeMode: "system" | "light" | "dark";
  loginBackground?: string | null;
  /** Per-language HTML fragment (or legacy plain string). Resolved to a string at the document-render boundary. */
  documentHeaderHtml?: LocalizedText;
  /** Per-language HTML fragment (or legacy plain string). Resolved to a string at the document-render boundary. */
  documentFooterHtml?: LocalizedText;
  supportEmail?: string | null;
}

// ── Customization: Email / SMTP ───────────────

/**
 * Domain fields of the email-settings singleton. The SMTP password is stored
 * ONLY as `smtpPasswordEnc` (field-encrypted) and is write-only over the
 * API — a GET returns `smtpConfigured` instead (see `EmailSettingsView`). The
 * plaintext password is never stored, returned, or logged.
 */
export interface EmailSettingsData {
  smtpHost?: string | null;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername?: string | null;
  /** AES-256-GCM ciphertext of the SMTP password (never plaintext, never returned). */
  smtpPasswordEnc?: string | null;
  fromEmail?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
}

/**
 * The API-safe projection of email settings: the secret ciphertext is dropped
 * and replaced by a boolean. This is the ONLY shape that leaves the API for the
 * email group (returned by GET and PATCH).
 */
export interface EmailSettingsView {
  smtpHost?: string | null;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername?: string | null;
  fromEmail?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
  /** True when an SMTP password has been set (ciphertext present). Never the value. */
  smtpConfigured: boolean;
}

// ── Customization: Localization ───────────────────────

/** Domain fields of the localization-settings singleton. */
export interface LocalizationSettingsData {
  defaultCurrency: string; // ISO 4217
  defaultLocale: "en" | "es" | "it" | "fr" | "ru" | "pt" | "de";
  timezone: string; // IANA
  dateFormat: string;
  numberFormat: string;
  firstDayOfWeek: number; // 0 = Sunday … 6 = Saturday
}

// ── Customization: Documents ──────────────────────────

/** Domain fields of the documents-settings singleton. */
export interface DocumentsSettingsData {
  defaultPaymentTermsDays: number;
  defaultTaxRate: number; // percentage, 0..100
  invoiceNotes?: string | null;
  quoteNotes?: string | null;
  pdfTemplate: string; // template id/choice
  /** Position of the COMPANY logo on documents. Left = logo left / company details right; right INVERTS. */
  logoPosition: "left" | "right";
  /** When true AND the invoice carries a bankSnapshot, render a bank-details block on documents. */
  showBankDetails: boolean;
  /** COMPANY logo shown ON DOCUMENTS — distinct from branding.logoFileId (the APP logo). Null → show company name text. */
  companyLogoFileId?: string | null;
  /** Per-language HTML header wrapping rendered contract documents (or legacy plain string). Null/omitted → falls back to the shared documentHeaderHtml. Resolved to a string at the document-render boundary. */
  contractHeaderHtml?: LocalizedText;
  /** Per-language HTML footer wrapping rendered contract documents (or legacy plain string). Null/omitted → falls back to the shared documentFooterHtml. Resolved to a string at the document-render boundary. */
  contractFooterHtml?: LocalizedText;
  /** Per-language HTML header wrapping outgoing emails (or legacy plain string). Null/omitted → no email header. Resolved to a string at the email-render boundary. */
  emailHeaderHtml?: LocalizedText;
  /** Per-language HTML footer wrapping outgoing emails (or legacy plain string). Null/omitted → no email footer. Resolved to a string at the email-render boundary. */
  emailFooterHtml?: LocalizedText;
}

// ── Customization: Feature toggles / policy ───────────

/**
 * Domain fields of the toggles-settings singleton — a DB-overridable subset of
 * env config. Each key documents its env
 * fallback; the effective value is resolved DB → env → default at the consumer.
 */
export interface TogglesSettingsData {
  require2fa: "off" | "admins" | "all";
  clamavEnabled: boolean;
  backupEnabled: boolean;
  backupSchedule: string; // cron expression
  backupRetentionDays: number;
  softDeleteRetentionDays: number;
  uploadMaxBytes: number;
  sessionIdleTtlMinutes: number;
  sessionAbsoluteTtlMinutes: number;
  allowPublicLinks: boolean;
}

// ── Singleton document shapes (BaseDoc + fixed key + group data) ──────────────

interface SettingsDocBase extends BaseDoc {
  key: SettingsKey;
}

export interface BusinessSettingsDoc extends SettingsDocBase {
  key: "business";
  data: BusinessSettingsData;
}

export interface TaxSettingsDoc extends SettingsDocBase {
  key: "tax";
  data: TaxSettingsData;
}

export interface NumberingSettingsDoc extends SettingsDocBase {
  key: "numbering";
  data: NumberingSettingsData;
}

export interface BrandingSettingsDoc extends SettingsDocBase {
  key: "branding";
  data: BrandingSettingsData;
}

export interface EmailSettingsDoc extends SettingsDocBase {
  key: "email";
  data: EmailSettingsData;
}

export interface LocalizationSettingsDoc extends SettingsDocBase {
  key: "localization";
  data: LocalizationSettingsData;
}

export interface DocumentsSettingsDoc extends SettingsDocBase {
  key: "documents";
  data: DocumentsSettingsData;
}

export interface TogglesSettingsDoc extends SettingsDocBase {
  key: "toggles";
  data: TogglesSettingsData;
}

export type SettingsDoc =
  | BusinessSettingsDoc
  | TaxSettingsDoc
  | NumberingSettingsDoc
  | BrandingSettingsDoc
  | EmailSettingsDoc
  | LocalizationSettingsDoc
  | DocumentsSettingsDoc
  | TogglesSettingsDoc;

/** Map a settings key to its stored data shape. */
export interface SettingsDataByKey {
  business: BusinessSettingsData;
  tax: TaxSettingsData;
  numbering: NumberingSettingsData;
  branding: BrandingSettingsData;
  email: EmailSettingsData;
  localization: LocalizationSettingsData;
  documents: DocumentsSettingsData;
  toggles: TogglesSettingsData;
}

// ── Per-user UI settings (backs the settings.ts store) ────

export interface UserTablePrefs {
  visibility: string[];
  order: string[];
  ipp?: number;
  defaultSort?: { key: string; order: "asc" | "desc" }[];
}

/** The `UserSettings` prefs shape. */
export interface UserSettingsData {
  tables: Record<string, UserTablePrefs>;
  theme: "system" | "light" | "dark";
  density: "comfortable" | "compact";
  locale?: "en" | "es" | "it" | "fr" | "ru" | "pt" | "de";
  quickActions?: string[];
}

/** Stored per-user settings doc — keyed by `userId`, kept lean (prefs + audit). */
export interface UserSettingsDoc extends UserSettingsData {
  userId: string;
  createdAt: string;
  updatedAt: string;
}
