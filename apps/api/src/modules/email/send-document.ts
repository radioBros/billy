import type { AuthContext } from "@billy/types";
import type { Db } from "mongodb";
import { errors, resolvePlaceholders, type TemplateContext } from "@billy/shared";
import type { PdfDocumentType, PdfService } from "@/modules/pdf-generation/service.js";
import { EmailService, type SendInput, type SupportedEmailLocale } from "@/modules/email/service.js";
import { EMAIL_TEMPLATES, type ComposedMessage, type EmailTemplate } from "@/modules/email/types.js";

/**
 * Reusable document-send orchestration (invoice + contract /send + /send/preview).
 *
 * The API composes a DEFAULT email (subject + body) from the email-service
 * template, attaches the document's already-rendered CLEAN PDF (enqueuing a render
 * when none exists yet — mirroring pdf-generation's return-if-exists-else-render),
 * and enqueues an `email` job. The worker resolves the attachment ref to bytes and
 * performs the SMTP send. Subject/body supplied by the caller are sent VERBATIM
 * (edit-for-this-send-only — never persisted).
 *
 * This helper is document-agnostic: callers inject `loadDoc` + the mapping from a
 * loaded doc to the recipient/compose variables, so invoices and contracts share
 * one code path.
 */

const PDF_CONTENT_TYPE = "application/pdf";
const SETTINGS_COLLECTION = "settings";
const FILES_COLLECTION = "files";

/** The "kind" of send — an ordinary send vs a reminder (template/copy variant). */
export type SendKind = "invoice" | "reminder";

/** The clean-PDF FileObject subset the send flow reads. */
interface CleanPdfFile {
  id: string;
  filename?: string | null;
  sizeBytes?: number | null;
  scanStatus?: string | null;
}

/** Total attachment size ceiling for an outgoing email (doc PDF + user attachments). */
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** The parsed, validated /send request body (shared shape for invoice + contract). */
export interface SendRequestBody {
  to?: string;
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  kind?: SendKind;
  /** Request a read receipt (Disposition-Notification-To on the sent mail). */
  requestReadReceipt?: boolean;
  /** Extra user-attached file ids (uploaded via files-storage) to send ALONGSIDE the
   *  document PDF. Each must be scan-clean + account-owned; the combined size (doc PDF
   *  + these) must stay within MAX_TOTAL_ATTACHMENT_BYTES. */
  attachmentFileIds?: string[];
  /** BCC the company's own email (business settings) so the sender keeps a copy. */
  copyToCompany?: boolean;
}

/** Compose inputs derived from a loaded document. */
export interface SendComposeContext {
  /** Default recipient (client email) when the request omits `to`. */
  defaultTo: string | null;
  /** Template variables for the default compose (business-name, number, amount, link…). */
  templateData: Record<string, unknown>;
  /** Filename to use for the attached PDF (falls back to the FileObject's own). */
  attachmentFilename: string;
  /**
   * Recipient locale for the composed prose, resolved from the document's client
   * (and, later, the company default). Optional; when omitted, compose defaults to
   * `"en"`. Populate via `resolveDocumentLocale(doc.clientSnapshot?.preferredLanguage)`.
   */
  locale?: string;
  /**
   * Placeholder-resolution context for the OUTGOING email subject/body — the same
   * `{{...}}` grammar used in document free-text. Built from the loaded document +
   * company branding (mirrors preview.ts `resolveDocText`). When present, the final
   * message subject/html/text are resolved against it at send time, so a user-typed
   * `{{client.name}}` / `{{date -1|"MMMM"}}` in the send popup becomes real values.
   * Optional; when omitted, subject/body are sent verbatim (no resolution).
   */
  templateContext?: TemplateContext;
}

export interface SendDocumentDeps {
  db: Db;
  emailService: EmailService;
  pdfService: PdfService;
  ownerType: PdfDocumentType;
  /**
   * The document family — drives the DEFAULT email template + default kind:
   *  - "invoice" → `invoice-sent` copy (kind defaults "invoice").
   *  - "contract" → `generic-notification` copy (a contract is not an invoice, so
   *    it never renders invoice-branded prose); kind still defaults "invoice" but
   *    resolves to the generic template.
   */
  docKind: "invoice" | "contract";
}

const businessName = async (db: Db): Promise<string> => {
  const doc = (await db
    .collection<{ key: string; data?: { businessName?: string | null } }>(SETTINGS_COLLECTION)
    .findOne({ key: "business" }, { projection: { _id: 0 } })) as
    | { data?: { businessName?: string | null } }
    | null;
  return doc?.data?.businessName ?? "";
};

/** The company's own email from the account's business settings (for send copies). */
const companyEmail = async (db: Db, accountId: string): Promise<string | null> => {
  const doc = (await db
    .collection<{ key: string; accountId?: string | null; data?: { email?: string | null } }>(SETTINGS_COLLECTION)
    .findOne({ key: "business", accountId } as never, { projection: { _id: 0 } })) as
    | { data?: { email?: string | null } }
    | null;
  const email = doc?.data?.email ?? null;
  return email && email.trim().length > 0 ? email.trim() : null;
};

const findCleanPdf = async (db: Db, ownerType: PdfDocumentType, ownerId: string): Promise<CleanPdfFile | null> => {
  const rows = (await db
    .collection(FILES_COLLECTION)
    .find(
      { ownerType, ownerId, contentType: PDF_CONTENT_TYPE, deletedAt: null } as never,
      { projection: { _id: 0 } },
    )
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray()) as unknown as CleanPdfFile[];
  const file = rows[0];
  if (!file || file.scanStatus !== "clean") return null;
  return file;
};

/** A user-attached file resolved for sending (validated: account-owned, scan-clean). */
interface ResolvedExtraAttachment {
  fileId: string;
  filename: string;
  sizeBytes: number;
}

/**
 * Resolve caller-supplied attachment file ids to send-ready refs. Each must belong to
 * the caller's account, not be deleted, and be scan-clean (never send an unscanned /
 * infected file). Unknown/forbidden/not-clean ids throw a validation error rather than
 * being silently dropped. Order is preserved. Returns [] for an empty/omitted list.
 */
const resolveExtraAttachments = async (
  db: Db,
  accountId: string,
  fileIds: string[] | undefined,
): Promise<ResolvedExtraAttachment[]> => {
  const ids = (fileIds ?? []).filter((s) => typeof s === "string" && s.length > 0);
  if (ids.length === 0) return [];
  const rows = (await db
    .collection(FILES_COLLECTION)
    .find({ id: { $in: ids }, accountId, deletedAt: null } as never, { projection: { _id: 0 } })
    .toArray()) as unknown as { id: string; filename?: string | null; sizeBytes?: number | null; scanStatus?: string | null }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const f = byId.get(id);
    if (!f) throw errors.validation("Attachment not found", { attachmentFileIds: "file.not_found" });
    if (f.scanStatus !== "clean") {
      throw errors.validation("Attachment not available (still scanning or blocked)", {
        attachmentFileIds: "file.not_clean",
      });
    }
    return { fileId: id, filename: f.filename || "attachment", sizeBytes: f.sizeBytes ?? 0 };
  });
};

type DocKind = SendDocumentDeps["docKind"];

const templateFor = (docKind: DocKind, kind: SendKind): EmailTemplate => {
  if (kind === "reminder" || docKind === "contract") return EMAIL_TEMPLATES.genericNotification;
  return EMAIL_TEMPLATES.invoiceSent;
};

export const composeDefault = (emailService: EmailService, to: string, docKind: DocKind, kind: SendKind, templateData: Record<string, unknown>, locale?: string): ComposedMessage => {
  const template = templateFor(docKind, kind);
  const number = String(templateData.invoiceNumber ?? templateData.number ?? "");
  const business = String(templateData.businessName ?? "");
  const amount = String(templateData.amountDue ?? templateData.total ?? "");
  // `compose` runtime-guards unknown locales back to "en" (see localeOf in service.ts),
  // so a plain string from the resolved document locale is safe to pass through.
  const loc = locale as SupportedEmailLocale | undefined;
  if (kind === "reminder") {
    // NOT YET catalog-localized: the reminder subject/body below are hardcoded
    // English. `loc` still localizes the surrounding genericNotification shell,
    // but this prose bypasses EMAIL_I18N until a `reminder` catalog slot exists.
    return emailService.compose(template, to, {
      subject: number ? `Reminder: ${number} is awaiting payment` : "Payment reminder",
      body: `This is a friendly reminder that ${number ? `document ${number}` : "your document"}${
        amount ? ` (${amount})` : ""
      } is awaiting payment${business ? ` from ${business}` : ""}.`,
      actionUrl: String(templateData.viewUrl ?? ""),
      actionLabel: "View document",
    }, loc);
  }
  if (template === EMAIL_TEMPLATES.genericNotification) {
    // Contract (non-reminder): document-appropriate generic copy.
    // NOT YET catalog-localized: subject/body prose below are hardcoded English;
    // `loc` localizes only the genericNotification shell. Left English until a
    // dedicated contract/document-notification catalog slot exists.
    return emailService.compose(template, to, {
      subject: number ? `${business ? `${business}: ` : ""}${number}` : (business || "Document"),
      body: `Please find ${number ? `"${number}"` : "the document"} attached${
        business ? ` from ${business}` : ""
      }.`,
      actionUrl: String(templateData.viewUrl ?? ""),
      actionLabel: "View document",
    }, loc);
  }
  return emailService.compose(template, to, templateData, loc);
};

/** Minimal branding subset needed to build the company tier of the send context.
 *  Fields are nullable to accept the pdf-generation `BrandingView` directly. */
export interface SendBranding {
  companyName?: string | null;
  appName?: string | null;
  companyEmail?: string | null;
  companyVatNumber?: string | null;
  companyAddressLines?: string[] | null;
}
/** The document facts the send template context is built from. */
export interface SendContextDoc {
  issueDate?: string | null;
  dueDate?: string | null;
  expiryDate?: string | null;
  number?: string | null;
  /** Pre-formatted display total (e.g. "€1,500.00"); already money-formatted by the caller. */
  total?: string | null;
  clientSnapshot?: {
    displayName?: string | null;
    email?: string | null;
    vatNumber?: string | null;
    /** Stored loosely (`unknown`) across doc types; narrowed defensively below. */
    billingAddress?: unknown;
  } | null;
  locale?: string;
}

/** Address parts read defensively from an `unknown` billingAddress snapshot. */
interface AddressParts {
  line1?: string | null;
  line2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
}
const asAddress = (v: unknown): AddressParts | null => {
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  const str = (x: unknown): string | null => (typeof x === "string" ? x : null);
  return {
    line1: str(a.line1),
    line2: str(a.line2),
    postalCode: str(a.postalCode),
    city: str(a.city),
    region: str(a.region),
    country: str(a.country),
  };
};

/**
 * Build the placeholder `TemplateContext` for an outgoing email from a loaded
 * document + company branding. Mirrors the context assembled in preview.ts
 * `resolveDocText`, so the SAME `{{...}}` tokens resolve identically whether they
 * appear in the document body or the email subject/body. `now` is the issue date
 * (deterministic; the engine takes no clock), matching document rendering.
 */
export const buildSendTemplateContext = (doc: SendContextDoc, branding: SendBranding): TemplateContext => {
  const addr = asAddress(doc.clientSnapshot?.billingAddress);
  return {
    now: doc.issueDate ?? undefined,
    issueDate: doc.issueDate ?? null,
    dueDate: doc.dueDate ?? null,
    expiryDate: doc.expiryDate ?? null,
    document: { number: doc.number ?? null, total: doc.total ?? null },
    client: {
      name: doc.clientSnapshot?.displayName ?? null,
      email: doc.clientSnapshot?.email ?? null,
      vat: doc.clientSnapshot?.vatNumber ?? null,
      address: addr
        ? { line1: addr.line1 ?? null, line2: addr.line2 ?? null, postalCode: addr.postalCode ?? null, city: addr.city ?? null, region: addr.region ?? null, country: addr.country ?? null }
        : null,
    },
    company: {
      name: branding.companyName ?? branding.appName ?? null,
      email: branding.companyEmail ?? null,
      vat: branding.companyVatNumber ?? null,
      address: { line1: (branding.companyAddressLines ?? []).join(", ") },
    },
    locale: doc.locale,
  };
};

/**
 * Resolve `{{...}}` placeholders in a composed message's subject/html/text. The
 * body is HTML from the RichTextEditor; double-quotes in text nodes are stored
 * literally (not `&quot;`), so a quoted-format token like `{{date -1|"MMMM"}}`
 * matches the placeholder grammar unchanged — no entity decoding needed.
 */
const resolveMessagePlaceholders = (message: ComposedMessage, tctx: TemplateContext): ComposedMessage => ({
  ...message,
  subject: resolvePlaceholders(message.subject, tctx),
  html: resolvePlaceholders(message.html, tctx),
  text: resolvePlaceholders(message.text, tctx),
});

export const previewDocumentSend = async (deps: SendDocumentDeps, ctx: AuthContext, docId: string, kind: SendKind, loadCompose: (ctx: AuthContext, docId: string) => Promise<SendComposeContext | null>): Promise<{ to: string; subject: string; html: string }> => {
  const compose = await loadCompose(ctx, docId);
  if (!compose) throw errors.notFound(`${deps.ownerType} not found`);
  const bn = await businessName(deps.db);
  const to = compose.defaultTo ?? "";
  const composed = composeDefault(deps.emailService, to, deps.docKind, kind, {
    businessName: bn,
    ...compose.templateData,
  }, compose.locale);
  // Resolve so the preview shows real values (consistent with the actual send).
  const message = compose.templateContext ? resolveMessagePlaceholders(composed, compose.templateContext) : composed;
  return { to, subject: message.subject, html: message.html };
};

export const sendDocument = async (deps: SendDocumentDeps, ctx: AuthContext, docId: string, body: SendRequestBody, compose: SendComposeContext): Promise<
  | { status: "queued"; emailJobId: string; pdfPending: false }
  | { status: "pending"; pdfJobId: string; pdfPending: true }
> => {
  const kind: SendKind = body.kind ?? "invoice";
  const to = (body.to ?? compose.defaultTo ?? "").trim();
  if (!to) {
    throw errors.validation("No recipient — provide `to` or set the client email", {
      to: "field.required",
    });
  }

  // Return-if-exists-ELSE-render (mirrors pdf-generation/routes.ts): the terminal
  // action (enqueue the email) happens ONLY when a clean PDF already exists. When
  // none exists we enqueue a render and return 200 { status: "pending" } WITHOUT
  // emailing — a PDF-less invoice email is never sent. The caller polls/re-sends
  // once the render lands (the frontend send flow re-invokes /send). This also
  // makes the API-side fileId knowable: the worker generates it at store time, so
  // the ref can only be attached after the render completes.
  const clean = await findCleanPdf(deps.db, deps.ownerType, docId);
  if (!clean) {
    const { jobId } = await deps.pdfService.enqueue(ctx, deps.ownerType, docId);
    return { status: "pending", pdfJobId: jobId, pdfPending: true };
  }
  const attachments: { fileId: string; filename: string }[] = [
    { fileId: clean.id, filename: clean.filename || compose.attachmentFilename },
  ];

  // Merge user-supplied extra attachments AFTER the document PDF, enforcing the REAL
  // combined-size ceiling (actual doc-PDF bytes + each extra) — the UI budget is only
  // a guide; this is the source of truth. Over-budget → 413-style validation error.
  const extras = await resolveExtraAttachments(deps.db, ctx.accountId, body.attachmentFileIds);
  if (extras.length > 0) {
    const total = (clean.sizeBytes ?? 0) + extras.reduce((sum, e) => sum + e.sizeBytes, 0);
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw errors.validation(
        `Attachments exceed the ${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / (1024 * 1024))} MB total limit`,
        { attachmentFileIds: "file.too_large_total" },
      );
    }
    for (const e of extras) attachments.push({ fileId: e.fileId, filename: e.filename });
  }

  const bn = await businessName(deps.db);
  const templateData = { businessName: bn, ...compose.templateData };

  // "Copy to company" → BCC the business's own email. Missing company email is a
  // hard validation error (a silently-dropped copy would betray the user's intent).
  let bcc = body.bcc ?? [];
  if (body.copyToCompany) {
    const company = await companyEmail(deps.db, ctx.accountId);
    if (!company) {
      throw errors.validation("Company email is not set in business settings", {
        copyToCompany: "company_email.missing",
      });
    }
    if (company !== to && !bcc.includes(company)) bcc = [...bcc, company];
  }

  // Verbatim subject/body override (edit-for-this-send-only) when the caller
  // supplies either; else compose the template default.
  const composed = composeDefault(deps.emailService, to, deps.docKind, kind, templateData, compose.locale);
  const assembled: ComposedMessage =
    body.subject !== undefined || body.body !== undefined
      ? {
          to,
          subject: body.subject ?? composed.subject,
          html: body.body ?? composed.html,
          text: body.body ?? composed.text,
        }
      : composed;

  // Resolve `{{...}}` placeholders in the OUTGOING message (SINGLE point — covers
  // user-typed tokens from the send popup, composed defaults, and the recurring
  // auto-send path, which never touches the modal). No context ⇒ sent verbatim.
  const message: ComposedMessage = compose.templateContext
    ? resolveMessagePlaceholders(assembled, compose.templateContext)
    : assembled;

  const sendInput: SendInput = {
    to,
    template: templateFor(deps.docKind, kind),
    data: templateData,
    accountId: ctx.accountId,
    ...(body.cc && body.cc.length > 0 ? { cc: body.cc } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    ...(body.requestReadReceipt ? { requestReadReceipt: true } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    // The message (verbatim override OR composed default) is always enqueued so
    // the send reflects the resolved recipient/data.
    message,
  };

  const emailJobId = await deps.emailService.send(sendInput);
  return { status: "queued", emailJobId, pdfPending: false };
};
