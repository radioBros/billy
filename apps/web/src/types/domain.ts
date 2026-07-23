/**
 * Local frontend-shell domain types.
 *
 * INTEGRATOR NOTE: @billy/types does not (yet) export a canonical `Client` entity
 * nor the `/auth/me` principal body. These shapes are modelled from
 * the ClientSnapshot fields and @billy/types AuthContext,
 * for the shell's ClientsList columns and auth store only. Confirm/replace against
 * the real API contract when the client/auth modules land.
 */
import type { AuthContext, BaseDoc, Capabilities, Role } from "@billy/types";
import type { LocalizedText } from "@billy/shared/localized-text";

/** Client shape (modelled from clients/schema.ts; used by list + ClientForm). */
export interface Client extends BaseDoc {
  type: "company" | "individual";
  displayName: string;
  legalName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  vatNumber?: string | null;
  billingAddress?: Address | null;
  country?: string | null;
  preferredCurrency?: string | null;
  /** The client's language — documents + emails to them render in it. */
  preferredLanguage?: string | null;
  /** "First Last" contact-person (referral / attention-of). */
  referral?: string | null;
  tags?: string[];
}

/**
 * Account-scoped project. Optionally attached to documents via a project id.
 * `status` toggles between "active" and "archived" (edit only).
 */
export interface Project extends BaseDoc {
  name: string;
  description?: string | null;
  color?: string | null;
  status: "active" | "archived";
}

/**
 * The authenticated principal returned by GET /auth/me and the login/verify-2fa
 * endpoints. Modelled on AuthContext plus identity + auth-state fields. Replace
 * with the canonical type when available.
 */
export interface Principal extends AuthContext {
  displayName?: string;
  email?: string;
  /** True when the user must change their password before using the app. */
  mustChangePassword?: boolean;
  /** True when this session was established via a second (2FA) factor. */
  amrTwoFactor?: boolean;
}

/**
 * The two shapes POST /v1/auth/login can return. `authenticated` sets the
 * session cookie and carries the principal; `2fa_required` sets NO cookie and
 * carries a short-lived `pendingToken` to complete via /login/verify-2fa.
 */
export type LoginResult =
  | ({ status: "authenticated" } & Principal)
  | { status: "2fa_required"; pendingToken: string; expiresInMs: number };

// ── Users management (SafeUser) ───────────────────────────────────────────────
//
// INTEGRATOR NOTE: modelled from the confirmed backend contract for the users
// module (auth + canManageUsers). @billy/types exports no SafeUser entity yet.

/** A user row as returned by the users admin endpoints (never carries secrets). */
export interface SafeUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  capabilities: Capabilities;
  status: "active" | "disabled";
  mustChangePassword: boolean;
  totpEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** POST /v1/auth/totp/setup response (QR + otpauth URL to scan). */
export interface TotpSetup {
  otpauthUrl: string;
  /** PNG data URL of the QR code. */
  qrDataUrl: string;
}

// ── Shared money/line-item shapes ────────────────────────────────────────────
//
// INTEGRATOR NOTE: @billy/types exports no domain entities for the financial
// modules (only the envelope + BaseDoc + auth context), so the shapes below are
// modelled from the backend module `types.ts`/`schema.ts` files. ALL `*Minor`
// financial fields are declared OPTIONAL: the API strips them from responses for
// callers without `canViewFinancialTotals`, and pages must render a
// placeholder rather than assume presence. Reconcile if @billy/types later
// exports canonical entities.

/** Raw line-item input sent to the server (the only fields the server accepts). */
export interface LineItemInput {
  description: string;
  quantity: number;
  unitPriceMinor: number;
  discountRate?: number;
  taxRate?: number;
}

/** Server-computed line item returned in responses (money fields stripped when restricted). */
export interface LineItemComputed extends LineItemInput {
  lineSubtotalMinor?: number;
  lineDiscountMinor?: number;
  lineTaxMinor?: number;
  lineTotalMinor?: number;
}

// ── Invoices ─────────────────────────────────────────────────────────────────

export type InvoiceStatus =
  | "draft"
  | "scheduled"
  | "finalized"
  | "sent"
  | "partially_paid"
  | "paid"
  | "void";

export type PaymentMethod =
  | "bank_transfer"
  | "card"
  | "cash"
  | "paypal"
  | "stripe"
  | "direct_debit"
  | "other";

export interface Payment {
  id: string;
  amountMinor?: number;
  date: string;
  method: PaymentMethod;
  reference?: string | null;
  createdAt: string;
}

/** Snapshotted bank account attached to an invoice at create/issue (never a live FK). */
export interface BankSnapshot {
  label: string;
  details: string;
}

export interface Invoice extends BaseDoc {
  clientId: string;
  projectId?: string | null;
  invoiceNumber?: string | null;
  currency: string;
  issueDate: string;
  dueDate: string;
  subject?: string | null;
  /** Bank details snapshotted from the chosen bank account at create/issue. */
  bankSnapshot?: BankSnapshot | null;
  lineItems: LineItemComputed[];
  subtotalMinor?: number;
  discountMinor?: number;
  taxMinor?: number;
  grandTotalMinor?: number;
  amountPaidMinor?: number;
  amountDueMinor?: number;
  payments: Payment[];
  status: InvoiceStatus;
  /** YYYY-MM-DD the invoice will auto-finalize on; present when status is `scheduled`. */
  scheduledSendDate?: string | null;
  convertedFromQuoteId?: string | null;
  notes?: string | null;
}

// ── Quotes ───────────────────────────────────────────────────────────────────

export type QuoteStatus = "draft" | "sent" | "accepted" | "declined" | "expired" | "converted";

export interface Quote extends BaseDoc {
  clientId: string;
  projectId?: string | null;
  quoteNumber?: string | null;
  currency: string;
  issueDate: string;
  expiryDate: string;
  lineItems: LineItemComputed[];
  subtotalMinor?: number;
  discountMinor?: number;
  taxMinor?: number;
  grandTotalMinor?: number;
  status: QuoteStatus;
  subject?: string | null;
  notes?: string | null;
  publicToken?: string | null;
  convertedInvoiceId?: string | null;
}

// ── Expenses ─────────────────────────────────────────────────────────────────

export type ExpenseStatus = "draft" | "invoiced";

export interface Expense extends BaseDoc {
  amountMinor?: number;
  currency: string;
  category: string;
  date: string;
  vendor: string;
  description: string;
  clientId?: string;
  projectId?: string | null;
  billable: boolean;
  status: ExpenseStatus;
  invoicedAt?: string | null;
  invoiceId?: string | null;
}

// ── Contracts ────────────────────────────────────────────────────────────────

export type ContractStatus =
  | "draft"
  | "active"
  | "expiring"
  | "expired"
  | "terminated"
  | "renewed"
  | "archived";

export type ContractType =
  | "development"
  | "maintenance"
  | "hosting"
  | "support"
  | "consulting"
  | "service_agreement"
  | "retainer"
  | "other";

export interface Contract extends BaseDoc {
  clientId: string;
  projectId?: string | null;
  title: string;
  type: ContractType;
  status: ContractStatus;
  startDate: string;
  endDate?: string | null;
  valueMinor?: number | null;
  currency?: string | null;
  relatedRecurringProfileId?: string | null;
  fileId?: string | null;
  terms?: string | null;
  notes?: string | null;
  createdBy?: string | null;
}

// ── Time entries ─────────────────────────────────────────────────────────────

export type TimerState = "running" | "paused" | null;

export interface TimeEntry extends BaseDoc {
  userId: string;
  clientId?: string;
  projectId?: string;
  description: string;
  date: string;
  durationMinutes: number;
  billable: boolean;
  rateMinor?: number;
  billed: boolean;
  invoiceId?: string | null;
  timerStartedAt?: string | null;
  timerState?: TimerState;
}

// ── Subscriptions ────────────────────────────────────────────────────────────

export type SubscriptionInterval = "weekly" | "monthly" | "quarterly" | "yearly";
export type SubscriptionStatus = "active" | "paused" | "cancelled";

export interface Subscription extends BaseDoc {
  clientId?: string | null;
  projectId?: string | null;
  name: string;
  plan: string;
  amountMinor?: number;
  currency: string;
  interval: SubscriptionInterval;
  status: SubscriptionStatus;
  startDate: string;
  nextBillingDate: string;
  lastPaidAt?: string | null;
  url?: string | null;
  note?: string | null;
}

// ── Recurring profiles ─────────────────────────────────────────────────────
//
// INTEGRATOR NOTE: modelled from apps/api recurring-billing/types.ts. A profile
// is the template the scheduler reads to generate invoices. All `*Minor` fields
// are optional (stripped for callers without canViewFinancialTotals).

export type RecurringInterval = "weekly" | "monthly" | "quarterly" | "yearly";
export type RecurringProfileStatus = "active" | "paused" | "completed" | "cancelled";
/** The one-off document type a recurring profile generates on schedule. */
export type RecurringDocumentType = "invoice" | "proforma" | "expense";

/**
 * Shape v-modelled by RecurringToggle. `null` when the "Make this recurring"
 * switch is off; otherwise carries the recurrence config the profile POST needs.
 */
export interface RecurrenceConfig {
  enabled: boolean;
  interval: RecurringInterval;
  intervalCount: number;
  /** "Every Nth of the month" anchor (1–31) for monthly-family intervals; null = off. */
  dayOfMonth?: number | null;
  startDate: string;
  endDate?: string | null;
  maxOccurrences?: number | null;
}

export interface RecurringProfile extends BaseDoc {
  clientId: string;
  documentType: RecurringDocumentType;
  lineItems: LineItemComputed[];
  currency: string;
  interval: RecurringInterval;
  intervalCount: number;
  startDate: string;
  nextRunAt: string;
  endDate?: string | null;
  maxOccurrences?: number | null;
  occurrencesGenerated: number;
  status: RecurringProfileStatus;
  lastRunAt?: string | null;
  createdInvoiceIds: string[];
  subtotalMinor?: number;
  discountMinor?: number;
  taxMinor?: number;
  grandTotalMinor?: number;
  notes?: string | null;
}

/**
 * Draft payload returned by POST /recurring-profiles/:id/generate. The jobs
 * layer (not yet wired) turns this into a real invoice, so there is no created
 * invoice id to link to yet; `generate` returns this payload or `null` when the
 * profile is exhausted.
 */
export interface InvoiceDraftPayload {
  clientId: string;
  currency: string;
  lineItems: LineItemInput[];
  sourceRecurringProfileId: string;
  issueDate: string;
}

// ── Credit notes ────────────────────────────────────────────────────────────
//
// INTEGRATOR NOTE: modelled from apps/api credit-notes/types.ts. A credit note
// is a correcting document against a finalized invoice. draft → issued → void.

export type CreditNoteStatus = "draft" | "issued" | "void";

export interface CreditNote extends BaseDoc {
  clientId: string;
  projectId?: string | null;
  creditNoteNumber?: string | null;
  creditedInvoiceId: string;
  creditedInvoiceNumber?: string | null;
  currency: string;
  issueDate: string;
  lineItems: LineItemComputed[];
  subtotalMinor?: number;
  discountMinor?: number;
  taxMinor?: number;
  grandTotalMinor?: number;
  status: CreditNoteStatus;
  reason?: string | null;
  subject?: string | null;
  notes?: string | null;
}

// ── Proforma ──────────────────────────────────────────────────────────────────
//
// INTEGRATOR NOTE: modelled from apps/api proforma/types.ts. A proforma is a
// preliminary NON-FISCAL preview document. draft → issued → void.

export type ProformaStatus = "draft" | "issued" | "void";

export interface Proforma extends BaseDoc {
  clientId: string;
  projectId?: string | null;
  proformaNumber?: string | null;
  currency: string;
  issueDate: string;
  expiryDate?: string | null;
  lineItems: LineItemComputed[];
  subtotalMinor?: number;
  discountMinor?: number;
  taxMinor?: number;
  grandTotalMinor?: number;
  status: ProformaStatus;
  convertedInvoiceId?: string | null;
  subject?: string | null;
  notes?: string | null;
}

// ── Customization / settings groups ──────────────────────────────────────────
//
// INTEGRATOR NOTE: @billy/types does not (yet) export the settings-group bodies.
// These shapes are modelled from the backend contract (the admin GET/PATCH
// `/v1/settings/*` endpoints). Reconcile if @billy/types
// later exports canonical settings entities. No secret is ever present here: the
// SMTP password is write-only (BrandingSettings has none; EmailSettings GET carries
// only `smtpConfigured`, and PATCH accepts an optional write-only `smtpPassword`).

export type ThemeModePref = "system" | "light" | "dark";

/** GET/PATCH /v1/settings/branding. Colors are hex strings (#rrggbb). */
export interface BrandingSettings {
  appName: string;
  logoFileId: string | null;
  faviconFileId: string | null;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  defaultThemeMode: ThemeModePref;
  loginBackground: string | null;
  supportEmail: string | null;
  documentHeaderHtml: LocalizedText;
  documentFooterHtml: LocalizedText;
}

/** GET /v1/settings/email — NEVER carries the SMTP password. */
export interface EmailSettings {
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUsername: string | null;
  fromEmail: string | null;
  fromName: string | null;
  replyTo: string | null;
  /** True when a password is stored; the value itself is never returned. */
  smtpConfigured: boolean;
}

/** PATCH /v1/settings/email — adds the optional write-only password. */
export interface EmailSettingsUpdate {
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpSecure?: boolean;
  smtpUsername?: string | null;
  fromEmail?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
  /** Write-only: sent only when the admin enters a new password. */
  smtpPassword?: string;
}

/** POST /v1/settings/email/test result. */
export interface EmailTestResult {
  ok: boolean;
  error?: string;
}

/** GET/PATCH /v1/settings/localization. */
export interface LocalizationSettings {
  defaultCurrency: string;
  defaultLocale: string;
  timezone: string;
  dateFormat: string;
  numberFormat: string;
  /** 0 = Sunday … 6 = Saturday. */
  firstDayOfWeek: number;
}

/** GET/PATCH /v1/settings/documents. */
export interface DocumentSettings {
  // Real `documents` settings group (matches the backend documentsShape).
  defaultPaymentTermsDays: number;
  defaultTaxRate: number;
  invoiceNotes: LocalizedText;
  quoteNotes: LocalizedText;
  pdfTemplate?: string;
  // ── Email/contract header-footer HTML (Email/Contract Design tab) ────────────
  // Optional — PATCH is partial so each tab sends only its own subset.
  /** HTML wrapping the top of rendered contracts. */
  contractHeaderHtml?: LocalizedText;
  /** HTML wrapping the bottom of rendered contracts. */
  contractFooterHtml?: LocalizedText;
  /** HTML wrapping the top of outgoing emails. */
  emailHeaderHtml?: LocalizedText;
  /** HTML wrapping the bottom of outgoing emails. */
  emailFooterHtml?: LocalizedText;
  // ── Document-design fields (invoice-layout redesign) ────────────────────────
  // Edited in the Document Design tab; optional here so the numbering-focused
  // Documents tab (which sends the full shape) still typechecks. PATCH is
  // partial, so either tab may send only the subset it owns.
  /** Position of the COMPANY logo on documents. Right = columns inverted. */
  logoPosition?: "left" | "right";
  /** Render the bank-details block under the totals/footer when business bank details exist. */
  showBankDetails?: boolean;
  /** File id of the COMPANY logo shown ON DOCUMENTS (distinct from branding.logoFileId, the app logo). */
  companyLogoFileId?: string | null;
}

/** Partial PATCH body for the Document Design tab's documents-group fields. */
export type DocumentDesignSettings = Pick<
  DocumentSettings,
  "logoPosition" | "showBankDetails" | "companyLogoFileId"
>;

/** A single named bank account (multi-bank). `details` is freeform multiline text. */
export interface BankAccount {
  id: string;
  label: string;
  details: string;
}

/** Structured postal address. `country` is an ISO-3166-1 alpha-2 code. */
export interface Address {
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
}

/** GET/PATCH /v1/settings/business (company details shown on documents). */
export interface BusinessSettings {
  businessName: string;
  legalName: string | null;
  vatNumber: string | null;
  taxCode: string | null;
  address: Address | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  /** Multi-bank: named accounts the invoice editor can attach (snapshotted). */
  bankAccounts?: BankAccount[];
}

/** GET/PATCH /v1/settings/toggles (policy/feature toggles). */
export interface ToggleSettings {
  require2fa: "off" | "admins" | "all";
  clamavEnabled: boolean;
  backupEnabled: boolean;
  backupSchedule: string;
  backupRetentionDays: number;
  softDeleteRetentionDays: number;
  uploadMaxBytes: number;
  sessionIdleTtlMinutes: number;
  sessionAbsoluteTtlMinutes: number;
  allowPublicLinks: boolean;
}

/** POST /v1/files/request-upload response (files-storage upload flow). */
export interface FileUploadTicket {
  fileId: string;
  uploadUrl: string;
  /** Optional headers the presigned PUT requires. */
  headers?: Record<string, string>;
}

// ── Notifications ─────────────────────────────────────────────────────────────
//
// INTEGRATOR NOTE: mirrors apps/api notifications/types.ts (the in-app channel
// read model). @billy/types exports no Notification entity, so the shell models
// it here for the notification center. Reconcile if a canonical type later lands.

export type NotificationCategory =
  | "invoices"
  | "quotes"
  | "recurring_billing"
  | "time_tracking"
  | "expenses"
  | "contracts"
  | "subscriptions"
  | "system";

export type NotificationSeverity = "info" | "success" | "warning" | "critical";

/** In-app notification row (GET /v1/notifications). `readAt` null = unread. */
export interface Notification extends BaseDoc {
  userId: string;
  category: NotificationCategory;
  /** The domain-event name that produced this notification (e.g. `invoice.paid`). */
  type: string;
  /** Optional: older/seeded notifications may omit it — the bell falls back to a
   *  category icon then. Kept optional so the type matches real API/seed data. */
  severity?: NotificationSeverity;
  title: string;
  body: string;
  /** Optional i18n key for the title; when present, resolves via `t(titleKey, params)` with `title` as fallback. */
  titleKey?: string | null;
  /** Optional i18n key for the body; when present, resolves via `t(bodyKey, params)` with `body` as fallback. */
  bodyKey?: string | null;
  /** Interpolation params for `titleKey`/`bodyKey` (e.g. `{ entity: "INV-0007" }`). */
  params?: Record<string, string> | null;
  entityType?: string | null;
  entityId?: string | null;
  /** null = unread; ISO timestamp = read. */
  readAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * The realtime wire envelope pushed on the socket.io `"event"` channel — mirrors
 * apps/api realtime/projection.ts `WsEvent`. The payload is MINIMAL (ids + changed
 * fields), never a full document, so the client refetches detail as needed.
 */
export interface WsEvent {
  eventId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
