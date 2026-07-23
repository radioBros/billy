import { z } from "zod";
import { Address, CountryCode, Email, NonEmptyString } from "@billy/validation";
import { LOCALE_CODES } from "@billy/shared";
import type {
  BrandingSettingsData,
  BusinessSettingsData,
  DocumentsSettingsData,
  EmailSettingsData,
  LocalizationSettingsData,
  NumberingSettingsData,
  TaxSettingsData,
  TogglesSettingsData,
  UserSettingsData,
} from "@/modules/settings/types.js";

/**
 * Settings Zod schemas — one schema per group, shared by API + web. PATCH
 * schemas are `.partial()` (any subset of fields), but every field keeps a real
 * constraint so validation can actually fail (currency regex, enums, numbering
 * padding bounds, tax-rate shape). Primitives reused from `@billy/validation`.
 */

const Currency = z.string().regex(/^[A-Z]{3}$/u, { message: "currency.invalid" });
const Percent = z.number().min(0).max(100);
// Supported languages. The literal list is kept explicit so Zod infers the narrow
// union types the settings docs rely on; a load-time guard asserts it stays in
// sync with the shared LOCALES source of truth (packages/shared/src/locales.ts),
// so adding a locale there without updating here fails fast at boot.
const LANGUAGE_CODES = ["en", "es", "it", "fr", "ru", "pt", "de"] as const;
if (LANGUAGE_CODES.length !== LOCALE_CODES.length || !LANGUAGE_CODES.every((c) => LOCALE_CODES.includes(c))) {
  throw new Error("settings LanguageEnum is out of sync with @billy/shared LOCALE_CODES");
}
const LanguageEnum = z.enum(LANGUAGE_CODES);

// Company-authored free-text that may be written PER LANGUAGE. Stored as EITHER a
// plain string (legacy / single value) OR a `{ [localeCode]: string }` map. The
// renderer resolves it to the recipient's language via @billy/shared
// `resolveLocalized` (tolerant — old plain strings keep working, no migration).
const LocalizedText = z.union([
  z.string().trim(),
  z.record(z.string(), z.string()),
]).nullable().optional();

// ── Business settings ────────────────────────────────────────────────────────

/**
 * A single named bank account (multi-bank support). `details` is freeform
 * multiline text (a textarea value) rendered verbatim on documents. Snapshotted
 * onto the invoice at create — never referenced live (see invoices `bankSnapshot`).
 */
const BankAccountSchema = z.object({
  id: NonEmptyString,
  label: NonEmptyString,
  details: z.string(),
});

const businessShape = {
  businessName: NonEmptyString,
  legalName: NonEmptyString.nullable().optional(),
  vatNumber: z.string().trim().min(1).nullable().optional(),
  taxCode: z.string().trim().min(1).nullable().optional(),
  address: Address.nullable().optional(),
  email: Email.nullable().optional(),
  phone: z.string().trim().min(1).nullable().optional(),
  website: z.string().trim().url({ message: "url.invalid" }).nullable().optional(),
  logoFileId: z.string().trim().min(1).nullable().optional(),
  defaultCurrency: Currency,
  defaultLanguage: LanguageEnum,
  timezone: NonEmptyString,
  defaultPaymentTermsDays: z.number().int().nonnegative(),
  defaultTaxRate: Percent,
  /** Named bank accounts (multi-bank). Snapshotted onto the invoice at create. */
  bankAccounts: z.array(BankAccountSchema),
  invoiceFooter: LocalizedText,
  quoteFooter: LocalizedText,
} as const;

export const BusinessSettingsUpdateSchema = z.object(businessShape).partial();
export type BusinessSettingsUpdateInput = z.infer<typeof BusinessSettingsUpdateSchema>;

// ── Tax settings ─────────────────────────────────────────────────────────────

const TaxRateSchema = z.object({
  id: NonEmptyString,
  label: NonEmptyString,
  rate: Percent,
  isDefault: z.boolean().optional(),
  zeroRateLabel: z.string().trim().min(1).nullable().optional(),
});

const taxShape = {
  rates: z.array(TaxRateSchema),
  pricesIncludeTax: z.boolean(),
  perLineTax: z.boolean(),
  exemptionNote: z.string().trim().nullable().optional(),
} as const;

export const TaxSettingsUpdateSchema = z.object(taxShape).partial();
export type TaxSettingsUpdateInput = z.infer<typeof TaxSettingsUpdateSchema>;

// ── Numbering settings ───────────────────────────────────────────────────────

const NumberingSeriesSchema = z.object({
  prefix: z.string().trim().min(1).max(16),
  startNumber: z.number().int().positive(),
  padding: z.number().int().min(1).max(12),
  yearlyReset: z.boolean(),
});

const numberingShape = {
  quote: NumberingSeriesSchema,
  invoice: NumberingSeriesSchema,
  creditNote: NumberingSeriesSchema,
  proforma: NumberingSeriesSchema,
} as const;

export const NumberingSettingsUpdateSchema = z.object(numberingShape).partial();
export type NumberingSettingsUpdateInput = z.infer<typeof NumberingSettingsUpdateSchema>;

// ── Per-user UI settings ─────────────────────────────────────────────────────

const TablePrefsSchema = z.object({
  visibility: z.array(z.string()),
  order: z.array(z.string()),
  ipp: z.number().int().positive().optional(),
  defaultSort: z
    .array(z.object({ key: z.string(), order: z.enum(["asc", "desc"]) }))
    .optional(),
});

const userSettingsShape = {
  tables: z.record(z.string(), TablePrefsSchema),
  theme: z.enum(["system", "light", "dark"]),
  density: z.enum(["comfortable", "compact"]),
  locale: LanguageEnum.optional(),
  quickActions: z.array(z.string()).optional(),
} as const;

export const UserSettingsUpdateSchema = z.object(userSettingsShape).partial();
export type UserSettingsUpdateInput = z.infer<typeof UserSettingsUpdateSchema>;

// ── Customization: Branding ──────────────────────────────────────────────────

const HexColor = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/u, { message: "color.invalid" });

const brandingShape = {
  appName: NonEmptyString,
  logoFileId: z.string().trim().min(1).nullable().optional(),
  faviconFileId: z.string().trim().min(1).nullable().optional(),
  primaryColor: HexColor,
  secondaryColor: HexColor,
  accentColor: HexColor,
  defaultThemeMode: z.enum(["system", "light", "dark"]),
  loginBackground: z.string().trim().nullable().optional(),
  documentHeaderHtml: LocalizedText,
  documentFooterHtml: LocalizedText,
  supportEmail: Email.nullable().optional(),
} as const;

export const BrandingSettingsUpdateSchema = z.object(brandingShape).partial();
export type BrandingSettingsUpdateInput = z.infer<typeof BrandingSettingsUpdateSchema>;

// ── Customization: Email / SMTP ──────────────────────────────────────────────

/**
 * Email PATCH input. The password is accepted here as the write-only plaintext
 * field `smtpPassword`; the service field-encrypts it into `smtpPasswordEnc`
 * (never stored/returned as plaintext). `smtpPasswordEnc` itself is NOT an
 * accepted input — a client can never write raw ciphertext.
 */
const emailShape = {
  smtpHost: z.string().trim().min(1).nullable().optional(),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
  smtpUsername: z.string().trim().min(1).nullable().optional(),
  /** Write-only plaintext SMTP password. Encrypted by the service; never echoed. */
  smtpPassword: z.string().min(1).nullable().optional(),
  fromEmail: Email.nullable().optional(),
  fromName: z.string().trim().min(1).nullable().optional(),
  replyTo: Email.nullable().optional(),
} as const;

export const EmailSettingsUpdateSchema = z.object(emailShape).partial();
export type EmailSettingsUpdateInput = z.infer<typeof EmailSettingsUpdateSchema>;

// ── Customization: Localization ──────────────────────────────────────────────

const localizationShape = {
  defaultCurrency: Currency,
  defaultLocale: LanguageEnum,
  timezone: NonEmptyString,
  dateFormat: NonEmptyString,
  numberFormat: NonEmptyString,
  firstDayOfWeek: z.number().int().min(0).max(6),
} as const;

export const LocalizationSettingsUpdateSchema = z.object(localizationShape).partial();
export type LocalizationSettingsUpdateInput = z.infer<typeof LocalizationSettingsUpdateSchema>;

// ── Customization: Documents ─────────────────────────────────────────────────

const documentsShape = {
  defaultPaymentTermsDays: z.number().int().nonnegative(),
  defaultTaxRate: Percent,
  invoiceNotes: z.string().trim().nullable().optional(),
  quoteNotes: z.string().trim().nullable().optional(),
  pdfTemplate: NonEmptyString,
  /** Position of the COMPANY logo on documents. Left = logo left / company details right; right INVERTS the columns. */
  logoPosition: z.enum(["left", "right"]),
  /** When true AND the invoice carries a bankSnapshot, render a bank-details block on documents. */
  showBankDetails: z.boolean(),
  /** COMPANY logo shown ON DOCUMENTS — distinct from branding.logoFileId (the APP logo). Null → show company name text. */
  companyLogoFileId: z.string().trim().min(1).nullable().optional(),
  /** HTML header wrapping rendered contract documents (per-language). Null/omitted → falls back to the shared documentHeaderHtml. */
  contractHeaderHtml: LocalizedText,
  /** HTML footer wrapping rendered contract documents (per-language). Null/omitted → falls back to the shared documentFooterHtml. */
  contractFooterHtml: LocalizedText,
  /** HTML header wrapping outgoing emails (per-language). Null/omitted → no email header. */
  emailHeaderHtml: LocalizedText,
  /** HTML footer wrapping outgoing emails (per-language). Null/omitted → no email footer. */
  emailFooterHtml: LocalizedText,
} as const;

export const DocumentsSettingsUpdateSchema = z.object(documentsShape).partial();
export type DocumentsSettingsUpdateInput = z.infer<typeof DocumentsSettingsUpdateSchema>;

// ── Customization: Feature toggles / policy ──────────────────────────────────

const togglesShape = {
  require2fa: z.enum(["off", "admins", "all"]),
  clamavEnabled: z.boolean(),
  backupEnabled: z.boolean(),
  backupSchedule: NonEmptyString,
  backupRetentionDays: z.number().int().nonnegative(),
  softDeleteRetentionDays: z.number().int().nonnegative(),
  uploadMaxBytes: z.number().int().positive(),
  sessionIdleTtlMinutes: z.number().int().positive(),
  sessionAbsoluteTtlMinutes: z.number().int().positive(),
  allowPublicLinks: z.boolean(),
} as const;

export const TogglesSettingsUpdateSchema = z.object(togglesShape).partial();
export type TogglesSettingsUpdateInput = z.infer<typeof TogglesSettingsUpdateSchema>;

// ── First-run defaults (settings seed on first-run) ──────────────────────────

export const DEFAULT_BUSINESS_SETTINGS: BusinessSettingsData = {
  businessName: "My Business",
  defaultCurrency: "EUR",
  defaultLanguage: "en",
  timezone: "Europe/Rome",
  defaultPaymentTermsDays: 30,
  defaultTaxRate: 22,
  bankAccounts: [],
};

export const DEFAULT_TAX_SETTINGS: TaxSettingsData = {
  rates: [
    { id: "standard", label: "Standard", rate: 22, isDefault: true },
    { id: "zero", label: "Zero-rated", rate: 0, zeroRateLabel: "Zero-rated" },
  ],
  pricesIncludeTax: false,
  perLineTax: true,
};

export const DEFAULT_NUMBERING_SETTINGS: NumberingSettingsData = {
  quote: { prefix: "Q-", startNumber: 1, padding: 4, yearlyReset: true },
  invoice: { prefix: "INV-", startNumber: 1, padding: 4, yearlyReset: true },
  creditNote: { prefix: "CN-", startNumber: 1, padding: 4, yearlyReset: true },
  proforma: { prefix: "PRO-", startNumber: 1, padding: 4, yearlyReset: true },
};

export const DEFAULT_USER_SETTINGS: UserSettingsData = {
  tables: {},
  theme: "system",
  density: "comfortable",
};

export const DEFAULT_BRANDING_SETTINGS: BrandingSettingsData = {
  appName: "Billy",
  primaryColor: "#1867C0",
  secondaryColor: "#5CBBF6",
  accentColor: "#82B1FF",
  defaultThemeMode: "system",
};

export const DEFAULT_EMAIL_SETTINGS: EmailSettingsData = {
  smtpPort: 587,
  smtpSecure: false,
  // smtpPasswordEnc intentionally absent by default → smtpConfigured:false.
};

export const DEFAULT_LOCALIZATION_SETTINGS: LocalizationSettingsData = {
  defaultCurrency: "EUR",
  defaultLocale: "en",
  timezone: "Europe/Rome",
  dateFormat: "dd/MM/yyyy",
  numberFormat: "1.234,56",
  firstDayOfWeek: 1,
};

export const DEFAULT_DOCUMENTS_SETTINGS: DocumentsSettingsData = {
  defaultPaymentTermsDays: 30,
  defaultTaxRate: 22,
  pdfTemplate: "default",
  logoPosition: "left",
  showBankDetails: true,
};

export const DEFAULT_TOGGLES_SETTINGS: TogglesSettingsData = {
  require2fa: "off",
  clamavEnabled: false,
  backupEnabled: false,
  backupSchedule: "0 2 * * *", // daily at 02:00
  backupRetentionDays: 30,
  softDeleteRetentionDays: 30,
  uploadMaxBytes: 26_214_400, // 25 MiB
  sessionIdleTtlMinutes: 60,
  sessionAbsoluteTtlMinutes: 720,
  allowPublicLinks: true,
};
