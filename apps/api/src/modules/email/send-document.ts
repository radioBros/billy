import type { AuthContext } from "@billy/types";
import type { Db } from "mongodb";
import { errors } from "@billy/shared";
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
  scanStatus?: string | null;
}

/** The parsed, validated /send request body (shared shape for invoice + contract). */
export interface SendRequestBody {
  to?: string;
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  kind?: SendKind;
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

export const previewDocumentSend = async (deps: SendDocumentDeps, ctx: AuthContext, docId: string, kind: SendKind, loadCompose: (ctx: AuthContext, docId: string) => Promise<SendComposeContext | null>): Promise<{ to: string; subject: string; html: string }> => {
  const compose = await loadCompose(ctx, docId);
  if (!compose) throw errors.notFound(`${deps.ownerType} not found`);
  const bn = await businessName(deps.db);
  const to = compose.defaultTo ?? "";
  const message = composeDefault(deps.emailService, to, deps.docKind, kind, {
    businessName: bn,
    ...compose.templateData,
  }, compose.locale);
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

  const bn = await businessName(deps.db);
  const templateData = { businessName: bn, ...compose.templateData };

  // Verbatim subject/body override (edit-for-this-send-only) when the caller
  // supplies either; else compose the template default.
  const composed = composeDefault(deps.emailService, to, deps.docKind, kind, templateData, compose.locale);
  const message: ComposedMessage =
    body.subject !== undefined || body.body !== undefined
      ? {
          to,
          subject: body.subject ?? composed.subject,
          html: body.body ?? composed.html,
          text: body.body ?? composed.text,
        }
      : composed;

  const sendInput: SendInput = {
    to,
    template: templateFor(deps.docKind, kind),
    data: templateData,
    accountId: ctx.accountId,
    ...(body.cc && body.cc.length > 0 ? { cc: body.cc } : {}),
    ...(body.bcc && body.bcc.length > 0 ? { bcc: body.bcc } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    // The message (verbatim override OR composed default) is always enqueued so
    // the send reflects the resolved recipient/data.
    message,
  };

  const emailJobId = await deps.emailService.send(sendInput);
  return { status: "queued", emailJobId, pdfPending: false };
};
