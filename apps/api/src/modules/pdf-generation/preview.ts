import type { Db } from "mongodb";
import { countryName, resolveDocumentLocale, resolveLocalized, resolvePlaceholders, type LocalizedText, type TemplateContext } from "@billy/shared";
import type { MinioConn } from "@/infrastructure/minio.js";
import { FILES_BUCKET } from "@/modules/files-storage/service.js";
import {
  formatMoney,
  renderContractHtml,
  renderInvoiceHtml,
  renderQuoteHtml,
  type BrandingView,
  type ContractView,
  type InvoiceView,
  type QuoteView,
  type TemplateClientSnapshot,
  type TemplateLineItem,
} from "@/modules/pdf-generation/template.js";
import type { PdfDocumentType } from "@/modules/pdf-generation/service.js";
import { computeDocumentTotals, type LineItemInput } from "@/platform/money.js";

/**
 * Resolve {{...}} placeholders in a document's free-text fields before the pure
 * builder — mirrors the worker's resolveDocText (apps/worker/src/handlers/pdf.ts).
 */
interface RenderableDoc {
  issueDate?: string;
  dueDate?: string | null;
  expiryDate?: string | null;
  currency?: string;
  grandTotalMinor?: number;
  notes?: string | null;
  terms?: string | null;
  lineItems?: { description: string }[];
  clientSnapshot?: { displayName?: string; email?: string | null; vatNumber?: string | null } | null;
  [k: string]: unknown;
}
const resolveDocText = <T>(docIn: T, branding: BrandingView, docNumber: string): T => {
  const doc = docIn as RenderableDoc;
  const ctx: TemplateContext = {
    now: doc.issueDate,
    issueDate: doc.issueDate ?? null,
    dueDate: doc.dueDate ?? null,
    expiryDate: doc.expiryDate ?? null,
    document: {
      number: docNumber,
      total: doc.currency != null && doc.grandTotalMinor != null ? formatMoney(doc.grandTotalMinor, doc.currency) : null,
    },
    client: {
      name: doc.clientSnapshot?.displayName ?? null,
      email: doc.clientSnapshot?.email ?? null,
      vat: doc.clientSnapshot?.vatNumber ?? null,
    },
    company: {
      name: branding.companyName ?? branding.appName ?? null,
      email: branding.companyEmail ?? null,
      vat: branding.companyVatNumber ?? null,
      address: { line1: (branding.companyAddressLines ?? []).join(", ") },
    },
  };
  const out: RenderableDoc = {
    ...doc,
    notes: doc.notes != null ? resolvePlaceholders(doc.notes, ctx) : doc.notes,
    lineItems: doc.lineItems?.map((li) => ({ ...li, description: resolvePlaceholders(li.description, ctx) })),
  };
  if (typeof doc.terms === "string") out.terms = resolvePlaceholders(doc.terms, ctx);
  return out as T;
};

/**
 * API-side HTML preview assembly. The api renders preview HTML PURELY via the
 * template.ts builders — NO Playwright. It loads the source doc + a branding
 * view-model and returns the built HTML string.
 *
 * The branding assembler MIRRORS the worker's `fetchBranding` field-mapping
 * (apps/worker/src/handlers/pdf.ts): it reads the branding/business/documents
 * settings singletons directly from the `settings` collection (single-tenant
 * singletons keyed by a fixed `key`) and maps them into a BrandingView. Reading the
 * collection directly (rather than via the settings service) keeps this render path
 * decoupled from the settings module's auth-scoped DI, exactly like the worker.
 *
 * The company logo (documents.companyLogoFileId) is resolved to a base64 `data:`
 * URI from MinIO ONCE per render (see `resolveLogoDataUri`) and injected into the
 * BrandingView — byte-consistent with the worker's canonical render path. When
 * absent (no logo / not clean / any error) the header falls back to the
 * company-name text. Consistent by design.
 */

const SETTINGS_COLLECTION = "settings";
const FILES_COLLECTION = "files";

/** Collect a Readable (minio getObject) stream into a single Buffer. */
const streamToBuffer = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

/**
 * Resolve `documents.companyLogoFileId` → a Chromium-loadable base64 `data:` URI
 * (byte-consistent with the worker's `resolveLogoDataUri`).
 *
 * fileId → files.findOne({ id, deletedAt: null, accountId }) → objectKey +
 * contentType → MinIO getObject → Buffer → `data:<contentType>;base64,<...>`.
 * ONLY a `clean` file is embedded (mirrors the files-storage download gate). Any
 * miss (no minio / no fileId / file gone / not clean / storage error) → undefined
 * so the header falls back to the company-name text. NEVER throws.
 */
const resolveLogoDataUri = async (
  db: Db,
  minio: MinioConn | undefined,
  accountId: string,
  fileId: string | null | undefined,
): Promise<string | undefined> => {
  if (!minio || !fileId) return undefined;
  try {
    const file = await db
      .collection<{ id: string; objectKey: string; contentType: string; scanStatus: string }>(FILES_COLLECTION)
      .findOne({ id: fileId, deletedAt: null, accountId } as never, { projection: { _id: 0 } });
    if (!file || file.scanStatus !== "clean") return undefined;
    const stream = await minio.client.getObject(FILES_BUCKET, file.objectKey);
    const buf = await streamToBuffer(stream);
    return `data:${file.contentType};base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
};

// ── Stored settings-doc shapes (subset consumed here; mirrors the worker) ─────
interface StoredAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}
interface StoredBusinessData {
  businessName?: string | null;
  vatNumber?: string | null;
  taxCode?: string | null;
  address?: StoredAddress | null;
  email?: string | null;
}
interface StoredDocumentsData {
  logoPosition?: "left" | "right";
  showBankDetails?: boolean;
  companyLogoFileId?: string | null;
  // Localized free-text (string | per-locale map) — resolved to a string at the boundary.
  contractHeaderHtml?: LocalizedText;
  contractFooterHtml?: LocalizedText;
}
interface StoredBrandingData {
  appName?: string | null;
  primaryColor?: string | null;
  secondaryColor?: string | null;
  // Localized free-text (string | per-locale map) — resolved to a string at the boundary.
  documentHeaderHtml?: LocalizedText;
  documentFooterHtml?: LocalizedText;
}
/** The company localization singleton — only `defaultLocale` is needed here (company-default fallback tier). */
interface StoredLocalizationData {
  defaultLocale?: string | null;
}

/**
 * Raw branding sources + the company default locale, fetched ONCE per render.
 * Header/footer free-text stays UNRESOLVED here (it needs the per-document
 * locale, computed later) — `resolveBrandingView` turns it into the plain-string
 * BrandingView the templates consume.
 */
interface RawBrandingSources {
  branding?: StoredBrandingData;
  business?: StoredBusinessData;
  documents?: StoredDocumentsData;
  /** localization.defaultLocale — the company-default fallback tier for locale + free-text resolution. */
  companyDefault?: string;
}

const formatAddressLines = (address: StoredAddress | null | undefined, locale: string): string[] => {
  if (!address) return [];
  const lines: string[] = [];
  if (address.line1) lines.push(address.line1);
  if (address.line2) lines.push(address.line2);
  // Locality line: postal code, city, province, and COUNTRY all on ONE line. The
  // country renders as its localized full name (ISO alpha-2 → name via countryName).
  const localityLine = [address.postalCode, address.city, address.region ? `(${address.region})` : "", countryName(address.country, locale)]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (localityLine.length > 0) lines.push(localityLine);
  return lines;
};

/**
 * Fetch the raw branding sources + company default locale ONCE per render. The
 * localized header/footer free-text is returned RAW (string OR per-locale map);
 * it is resolved to a plain string by `resolveBrandingView` after the recipient's
 * document locale is known. Reading localization.defaultLocale here activates the
 * company-default fallback tier for both locale selection and free-text resolution.
 */
const fetchBrandingSources = async (db: Db, accountId: string): Promise<RawBrandingSources> => {
  const settings = db.collection<{ key: string; data: Record<string, unknown> }>(SETTINGS_COLLECTION);
  // Per-account settings singletons — scope every read by accountId.
  const [brandingDoc, businessDoc, documentsDoc, localizationDoc] = await Promise.all([
    settings.findOne({ key: "branding", accountId } as never),
    settings.findOne({ key: "business", accountId } as never),
    settings.findOne({ key: "documents", accountId } as never),
    settings.findOne({ key: "localization", accountId } as never),
  ]);
  const localization = localizationDoc?.data as StoredLocalizationData | undefined;
  return {
    branding: brandingDoc?.data as StoredBrandingData | undefined,
    business: businessDoc?.data as StoredBusinessData | undefined,
    documents: documentsDoc?.data as StoredDocumentsData | undefined,
    companyDefault: localization?.defaultLocale ?? undefined,
  };
};

/**
 * Build the plain-string BrandingView the templates consume, resolving each
 * localized free-text field to the recipient's `locale` (with the company
 * `companyDefault` as the middle fallback tier). Legacy plain strings pass through
 * unchanged (`resolveLocalized` returns them as-is).
 */
const resolveBrandingView = (raw: RawBrandingSources, locale: string, companyLogoUrl?: string): BrandingView => {
  const { branding, business, documents, companyDefault } = raw;
  const showBankDetails = documents?.showBankDetails ?? true;
  const rl = (field: LocalizedText): string | undefined => {
    const s = resolveLocalized(field, locale, companyDefault);
    return s.length > 0 ? s : undefined;
  };
  return {
    appName: branding?.appName || "Billy",
    primaryColor: branding?.primaryColor ?? undefined,
    secondaryColor: branding?.secondaryColor ?? undefined,
    documentHeaderHtml: rl(branding?.documentHeaderHtml),
    documentFooterHtml: rl(branding?.documentFooterHtml),
    contractHeaderHtml: rl(documents?.contractHeaderHtml),
    contractFooterHtml: rl(documents?.contractFooterHtml),
    companyName: business?.businessName ?? undefined,
    companyLogoUrl, // base64 data URI resolved once per render (byte-consistent with the worker).
    companyAddressLines: formatAddressLines(business?.address, locale),
    companyVatNumber: business?.vatNumber ?? undefined,
    companyTaxCode: business?.taxCode ?? undefined,
    companyEmail: business?.email ?? undefined,
    logoPosition: documents?.logoPosition ?? "left",
    showBankDetails,
    bankLines: [], // populated per-document from the invoice's bankSnapshot.
  };
};

/**
 * Assemble the plain-string BrandingView for a render. Fetches the raw sources +
 * company default locale, then resolves each localized free-text field to `locale`.
 * `locale` should be the recipient's document locale
 * (`resolveDocumentLocale(clientLocale, companyDefault)`).
 */
export const assembleBranding = async (db: Db, accountId: string, locale = "en"): Promise<BrandingView> => {
  try {
    const raw = await fetchBrandingSources(db, accountId);
    if (!raw.branding && !raw.business && !raw.documents) return { appName: "Billy" };
    return resolveBrandingView(raw, locale);
  } catch {
    return { appName: "Billy" };
  }
};

const bankLinesFromSnapshot = (snapshot?: { details: string } | null): string[] => {
  if (!snapshot) return [];
  return snapshot.details
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
};

// ── Stored source-doc shapes (invoice-shaped families + contract) ─────────────

interface StoredInvoice extends InvoiceView {
  id: string;
  /** Snapshotted bank account attached at create; source of the document's bank block. */
  bankSnapshot?: { label: string; details: string } | null;
}
interface StoredQuote extends QuoteView {
  id: string;
}
interface StoredProforma {
  id: string;
  proformaNumber?: string | null;
  currency: string;
  issueDate: string;
  expiryDate?: string | null;
  subject?: string | null;
  clientSnapshot?: TemplateClientSnapshot | null;
  lineItems: TemplateLineItem[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  grandTotalMinor: number;
  notes?: string | null;
  status?: string;
}
interface StoredCreditNote {
  id: string;
  creditNoteNumber?: string | null;
  currency: string;
  issueDate: string;
  subject?: string | null;
  clientSnapshot?: TemplateClientSnapshot | null;
  lineItems: TemplateLineItem[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  grandTotalMinor: number;
  notes?: string | null;
  status?: string;
}
interface StoredContract extends ContractView {
  id: string;
}

const proformaToInvoiceView = (p: StoredProforma): InvoiceView => {
  return {
    invoiceNumber: p.proformaNumber ?? null,
    currency: p.currency,
    issueDate: p.issueDate,
    dueDate: p.expiryDate ?? p.issueDate,
    subject: p.subject ?? null,
    clientSnapshot: p.clientSnapshot,
    lineItems: p.lineItems,
    subtotalMinor: p.subtotalMinor,
    discountMinor: p.discountMinor,
    taxMinor: p.taxMinor,
    grandTotalMinor: p.grandTotalMinor,
    notes: p.notes,
    status: p.status,
  };
};

const creditNoteToInvoiceView = (c: StoredCreditNote): InvoiceView => {
  return {
    invoiceNumber: c.creditNoteNumber ?? null,
    currency: c.currency,
    issueDate: c.issueDate,
    dueDate: c.issueDate,
    subject: c.subject ?? null,
    clientSnapshot: c.clientSnapshot,
    lineItems: c.lineItems,
    subtotalMinor: c.subtotalMinor,
    discountMinor: c.discountMinor,
    taxMinor: c.taxMinor,
    grandTotalMinor: c.grandTotalMinor,
    notes: c.notes,
    status: c.status,
  };
};

/** Collection name per document type (matches the api repositories). */
const COLLECTION_BY_TYPE: Record<PdfDocumentType, string> = {
  invoice: "invoices",
  quote: "quotes",
  proforma: "proformas",
  "credit-note": "creditNotes",
  contract: "contracts",
};

const loadDoc = async <T>(db: Db, type: PdfDocumentType, id: string, accountId: string): Promise<T | null> => {
  const doc = await db
    .collection<{ id: string }>(COLLECTION_BY_TYPE[type])
    .findOne({ id, deletedAt: null, accountId } as never, { projection: { _id: 0 } });
  return (doc as T | null) ?? null;
};

export const renderPreviewHtml = async (
  db: Db,
  documentType: PdfDocumentType,
  documentId: string,
  accountId: string,
  minio?: MinioConn,
): Promise<string | null> => {
  // Fetch raw branding sources + company default locale ONCE. The BrandingView is
  // resolved PER-DOCUMENT below, once the recipient's document locale is known — the
  // company default is the middle fallback tier for both locale + free-text.
  const raw = await fetchBrandingSources(db, accountId).catch(() => ({}) as RawBrandingSources);
  const companyDefault = raw.companyDefault;
  const hasBranding = Boolean(raw.branding || raw.business || raw.documents);
  // Resolve the company logo → base64 data URI ONCE (account-level, not per-locale).
  const companyLogoUrl = await resolveLogoDataUri(db, minio, accountId, raw.documents?.companyLogoFileId);
  // Build the plain-string BrandingView for the recipient's locale (activates the
  // company-default fallback tier via `companyDefault`).
  const brandingFor = (clientLocale?: string | null): { locale: string; branding: BrandingView } => {
    const locale = resolveDocumentLocale(clientLocale, companyDefault);
    const branding = hasBranding ? resolveBrandingView(raw, locale, companyLogoUrl) : { appName: "Billy" };
    return { locale, branding };
  };

  switch (documentType) {
    case "invoice": {
      const doc = await loadDoc<StoredInvoice>(db, "invoice", documentId, accountId);
      if (!doc) return null;
      const { locale, branding } = brandingFor(doc.clientSnapshot?.preferredLanguage);
      const r = resolveDocText(doc, branding, doc.invoiceNumber ?? "");
      // Bank lines come from the INVOICE's bankSnapshot (not settings). Non-invoice
      // types carry no snapshot, so their bankLines stay empty.
      return renderInvoiceHtml(r, { ...branding, bankLines: bankLinesFromSnapshot(doc.bankSnapshot) }, locale);
    }
    case "quote": {
      const doc = await loadDoc<StoredQuote>(db, "quote", documentId, accountId);
      if (!doc) return null;
      const { locale, branding } = brandingFor(doc.clientSnapshot?.preferredLanguage);
      return renderQuoteHtml(resolveDocText(doc, branding, doc.quoteNumber ?? ""), branding, locale);
    }
    case "proforma": {
      const doc = await loadDoc<StoredProforma>(db, "proforma", documentId, accountId);
      if (!doc) return null;
      const { locale, branding } = brandingFor(doc.clientSnapshot?.preferredLanguage);
      return renderInvoiceHtml(proformaToInvoiceView(resolveDocText(doc, branding, doc.proformaNumber ?? "")), branding, locale);
    }
    case "credit-note": {
      const doc = await loadDoc<StoredCreditNote>(db, "credit-note", documentId, accountId);
      if (!doc) return null;
      const { locale, branding } = brandingFor(doc.clientSnapshot?.preferredLanguage);
      return renderInvoiceHtml(creditNoteToInvoiceView(resolveDocText(doc, branding, doc.creditNoteNumber ?? "")), branding, locale);
    }
    case "contract": {
      const doc = await loadDoc<StoredContract>(db, "contract", documentId, accountId);
      if (!doc) return null;
      const { locale, branding } = brandingFor(doc.clientSnapshot?.preferredLanguage);
      return renderContractHtml(resolveDocText(doc, branding, ""), branding, locale);
    }
  }
};

// ── Live preview of an UNSAVED draft ──────────────────────────────────────────
// Renders preview HTML from the current (unsaved) form payload, so the user can
// see the document WHILE creating it — no persistence. Totals are recomputed
// server-side (never trust client totals), the recipient snapshot is built by
// reading the chosen client, and the same pure builders + localization are used.

/** The raw draft payload the create-form POSTs (subset the preview needs). */
export interface DraftPreviewPayload {
  clientId?: string | null;
  currency?: string;
  issueDate?: string;
  dueDate?: string | null;
  expiryDate?: string | null;
  subject?: string | null;
  notes?: string | null;
  lineItems?: LineItemInput[];
}

interface ClientForSnapshot {
  id: string;
  displayName: string;
  legalName?: string | null;
  email?: string | null;
  vatNumber?: string | null;
  billingAddress?: unknown | null;
  preferredLanguage?: string | null;
}

/**
 * Build the recipient snapshot for a draft preview by reading the chosen client
 * (mirrors the fields frozen at issue). Returns null when no/again unknown client.
 */
const draftClientSnapshot = async (
  db: Db,
  accountId: string,
  clientId?: string | null,
): Promise<TemplateClientSnapshot | null> => {
  if (!clientId) return null;
  const c = (await db
    .collection<{ id: string }>("clients")
    .findOne({ id: clientId, deletedAt: null, accountId } as never, { projection: { _id: 0 } })) as ClientForSnapshot | null;
  if (!c) return null;
  return {
    displayName: c.displayName,
    legalName: c.legalName ?? null,
    email: c.email ?? null,
    vatNumber: c.vatNumber ?? null,
    billingAddress: (c.billingAddress as TemplateClientSnapshot["billingAddress"]) ?? null,
    preferredLanguage: c.preferredLanguage ?? null,
  };
};

export const renderDraftPreviewHtml = async (
  db: Db,
  documentType: PdfDocumentType,
  accountId: string,
  payload: DraftPreviewPayload,
  minio?: MinioConn,
): Promise<string> => {
  const raw = await fetchBrandingSources(db, accountId).catch(() => ({}) as RawBrandingSources);
  const companyDefault = raw.companyDefault;
  const hasBranding = Boolean(raw.branding || raw.business || raw.documents);
  const snapshot = await draftClientSnapshot(db, accountId, payload.clientId);
  const locale = resolveDocumentLocale(snapshot?.preferredLanguage, companyDefault);
  // Resolve the company logo → base64 data URI ONCE (account-level, not per-locale).
  const companyLogoUrl = await resolveLogoDataUri(db, minio, accountId, raw.documents?.companyLogoFileId);
  const branding = hasBranding ? resolveBrandingView(raw, locale, companyLogoUrl) : { appName: "Billy" };

  const currency = payload.currency ?? "EUR";
  const issueDate = payload.issueDate ?? new Date().toISOString().slice(0, 10);
  const totals = computeDocumentTotals((payload.lineItems ?? []) as LineItemInput[]);
  const lineItems = totals.lines as unknown as TemplateLineItem[];
  const base = {
    currency,
    issueDate,
    subject: payload.subject ?? null,
    clientSnapshot: snapshot,
    lineItems,
    subtotalMinor: totals.subtotalMinor,
    discountMinor: totals.discountMinor,
    taxMinor: totals.taxMinor,
    grandTotalMinor: totals.grandTotalMinor,
    notes: payload.notes ?? null,
    status: "draft",
  };

  switch (documentType) {
    case "invoice": {
      const view: InvoiceView = { ...base, invoiceNumber: null, dueDate: payload.dueDate ?? issueDate };
      return renderInvoiceHtml(resolveDocText(view, branding, ""), branding, locale);
    }
    case "proforma": {
      const view: InvoiceView = { ...base, invoiceNumber: null, dueDate: payload.expiryDate ?? issueDate };
      return renderInvoiceHtml(resolveDocText(view, branding, ""), branding, locale);
    }
    case "credit-note": {
      const view: InvoiceView = { ...base, invoiceNumber: null, dueDate: issueDate };
      return renderInvoiceHtml(resolveDocText(view, branding, ""), branding, locale);
    }
    case "quote": {
      const view: QuoteView = { ...base, quoteNumber: null, expiryDate: payload.expiryDate ?? issueDate };
      return renderQuoteHtml(resolveDocText(view, branding, ""), branding, locale);
    }
    case "contract":
      // Contracts aren't created via the line-item form flow; no draft preview.
      return renderContractHtml({ title: payload.subject ?? "", startDate: issueDate } as ContractView, branding, locale);
  }
};
