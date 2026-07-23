import type { Logger } from "@billy/shared";
import type { EmailJob } from "@billy/types";
import {
  EMAIL_TEMPLATES,
  type ComposedMessage,
  type EmailQueuePort,
  type EmailTemplate,
  type RenderedEmailData,
  type TemplateData,
} from "@/modules/email/types.js";
import { EMAIL_I18N, type SupportedEmailLocale } from "@/modules/email/i18n.js";

/** Re-exported for callers that thread a recipient locale into compose/send. */
export type { SupportedEmailLocale } from "@/modules/email/i18n.js";

const localeOf = (locale: SupportedEmailLocale): SupportedEmailLocale => {
  // The catalog is a total Record over SupportedEmailLocale, but a caller may pass
  // an out-of-type value (e.g. from untyped stored settings); guard at runtime so an
  // unknown locale falls back to en and NEVER throws.
  return Object.prototype.hasOwnProperty.call(EMAIL_I18N["invoice-sent"], locale) ? locale : "en";
};

/**
 * EmailService — the API-side compose + enqueue surface.
 *
 *  - `compose(template, data)` renders a template + variables into a
 *    {@link ComposedMessage} (`{ to, subject, html, text }`). Templates are
 *    simple string builders — i18n keys and real HTML templating
 *    (e.g. MJML / a templating engine) are DEFERRED.
 *  - `send(payload)` composes then **enqueues** the rendered message onto the
 *    `email` queue via the injected {@link EmailQueuePort}. It NEVER sends
 *    inline — the actual SMTP send happens in the worker (worker
 *    isolation). The rendered subject/html/text travel inside
 *    `EmailJob.data`; the worker reads them and sends verbatim.
 */
export interface EmailServiceDeps {
  queue: EmailQueuePort;
  logger: Logger;
}

/** Input to {@link EmailService.send}. */
export interface SendInput {
  to: string;
  template: EmailTemplate;
  data?: TemplateData;
  accountId: string;
  /** Carbon-copy recipients (rides on the EmailJob; the worker passes them to SMTP). */
  cc?: string[];
  /** Blind carbon-copy recipients. */
  bcc?: string[];
  /** Reply-To address. */
  replyTo?: string;
  /** Attachment REFERENCES (fileId + filename) — the worker resolves bytes at send. */
  attachments?: { fileId: string; filename: string }[];
  /**
   * Pre-composed message override (edit-for-this-send-only). When set, its
   * subject/html/text are enqueued VERBATIM instead of composing from
   * `template`/`data`. Used by /send when the caller supplies subject/body.
   */
  message?: ComposedMessage;
  /**
   * Recipient locale for the composed prose. Optional; defaults to `"en"`.
   *
   * Thread the real recipient locale here once a caller
   * exists. No production caller of `EmailService.send` exists yet, so there is
   * no live locale to pass. When invoice/quote/auth flows start sending mail,
   * the source should be, in priority: the recipient user's `UserSettingsData.locale`
   * (auth mails) or the client/business `LocalizationSettingsData.defaultLocale` /
   * `BusinessSettingsData.defaultLanguage` (document mails). Until then this stays
   * `undefined` → en, so compose is locale-capable without inventing a data path.
   */
  locale?: SupportedEmailLocale;
  /**
   * Stable parts making this send unique → a deterministic BullMQ jobId so a
   * retry / double-submit does not double-email. Omit for fire-and-forget sends.
   */
  idempotencyParts?: readonly string[];
}

const esc = (value: unknown): string => {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const str = (data: TemplateData, key: string): string => {
  return String(data[key] ?? "");
};

const htmlShell = (bodyHtml: string): string => {
  return `<!doctype html><html><body>${bodyHtml}</body></html>`;
};

export class EmailService {
  readonly #queue: EmailQueuePort;
  readonly #logger: Logger;

  constructor(deps: EmailServiceDeps) {
    this.#queue = deps.queue;
    this.#logger = deps.logger;
  }

  /**
   * Render a template + variables into a composed message. Every template
   * produces BOTH an HTML and a plain-text body.
   * Missing variables render as empty strings (i18n-aware validation deferred).
   */
  compose(
    template: EmailTemplate,
    to: string,
    data: TemplateData = {},
    locale: SupportedEmailLocale = "en",
  ): ComposedMessage {
    const loc = localeOf(locale);
    switch (template) {
      case EMAIL_TEMPLATES.invoiceSent: {
        const number = str(data, "invoiceNumber");
        const amount = str(data, "amountDue");
        const business = str(data, "businessName");
        const link = str(data, "viewUrl");
        const t = EMAIL_I18N[EMAIL_TEMPLATES.invoiceSent][loc];
        // Subject/text take RAW vars; htmlBody takes ESCAPED vars (esc lives here,
        // not in the catalog) — preserving the html-escaped / text-raw split.
        return {
          to,
          subject: t.subject({ number, amount, business, link }),
          html: htmlShell(
            t.htmlBody({
              number: esc(number),
              amount: esc(amount),
              business: esc(business),
              link: esc(link),
            }),
          ),
          text: t.textBody({ number, amount, business, link }),
        };
      }
      case EMAIL_TEMPLATES.quoteSent: {
        const number = str(data, "quoteNumber");
        const amount = str(data, "total");
        const business = str(data, "businessName");
        const link = str(data, "viewUrl");
        const t = EMAIL_I18N[EMAIL_TEMPLATES.quoteSent][loc];
        return {
          to,
          subject: t.subject({ number, amount, business, link }),
          html: htmlShell(
            t.htmlBody({
              number: esc(number),
              amount: esc(amount),
              business: esc(business),
              link: esc(link),
            }),
          ),
          text: t.textBody({ number, amount, business, link }),
        };
      }
      case EMAIL_TEMPLATES.passwordReset: {
        const link = str(data, "resetUrl");
        const expiry = str(data, "expiresIn");
        const t = EMAIL_I18N[EMAIL_TEMPLATES.passwordReset][loc];
        return {
          to,
          subject: t.subject({ link, expiry }),
          html: htmlShell(t.htmlBody({ link: esc(link), expiry: esc(expiry) })),
          text: t.textBody({ link, expiry }),
        };
      }
      case EMAIL_TEMPLATES.emailVerification: {
        const link = str(data, "verifyUrl");
        const code = str(data, "code");
        const t = EMAIL_I18N[EMAIL_TEMPLATES.emailVerification][loc];
        return {
          to,
          subject: t.subject({ link, code }),
          html: htmlShell(t.htmlBody({ link: esc(link), code: esc(code) })),
          text: t.textBody({ link, code }),
        };
      }
      case EMAIL_TEMPLATES.genericNotification: {
        // Subject/body/actionLabel are caller-supplied (already localized upstream);
        // only the structural assembly comes from the catalog.
        const subject = str(data, "subject") || "Notification";
        const body = str(data, "body");
        const link = str(data, "actionUrl");
        const actionLabel = str(data, "actionLabel") || "Open";
        const t = EMAIL_I18N[EMAIL_TEMPLATES.genericNotification][loc];
        return {
          to,
          subject,
          html: htmlShell(
            t.htmlBody({ body: esc(body), link: esc(link), actionLabel: esc(actionLabel) }),
          ),
          text: t.textBody({ body, link, actionLabel }),
        };
      }
      default: {
        // Exhaustiveness: adding a template without a case is a compile error.
        const _never: never = template;
        throw new Error(`unknown email template: ${String(_never)}`);
      }
    }
  }

  /**
   * Compose then enqueue. Returns the BullMQ job id. The rendered subject/html/
   * text are carried inside `EmailJob.data` (the frozen `EmailJob` shape has no
   * dedicated fields and this section may not change it); `template` rides along
   * as a label. No SMTP happens here — the worker sends.
   */
  async send(input: SendInput): Promise<string> {
    // Verbatim override (edit-for-this-send-only) wins over template compose.
    const message =
      input.message ?? this.compose(input.template, input.to, input.data ?? {}, input.locale ?? "en");
    const rendered: RenderedEmailData = {
      subject: message.subject,
      html: message.html,
      text: message.text,
    };
    const payload: EmailJob = {
      to: input.to,
      template: input.template,
      accountId: input.accountId,
      ...(input.cc && input.cc.length > 0 ? { cc: input.cc } : {}),
      ...(input.bcc && input.bcc.length > 0 ? { bcc: input.bcc } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
      // Only the rendered message travels on the job — the worker reads exactly
      // subject/html/text. Raw template vars (which may include tokens/codes) are
      // NOT re-shipped, so no redundant secret rides in the queued payload.
      data: { ...rendered },
    };
    const jobId = await this.#queue.enqueue("email", payload, {
      ...(input.idempotencyParts ? { idempotencyParts: input.idempotencyParts } : {}),
    });
    // No PII/secret in logs — only the routing metadata.
    this.#logger.info(
      { template: input.template, accountId: input.accountId, jobId },
      "email enqueued",
    );
    return jobId;
  }
}
