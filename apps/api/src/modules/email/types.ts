import type { EmailJob } from "@billy/types";
import type { EnqueueOptions } from "@/platform/queue.js";

/**
 * Email module contracts.
 *
 * SPLIT-OF-CONCERNS (see service.ts): the API **composes** a message
 * (subject + HTML + text) from a template + data, then enqueues the *rendered*
 * message onto the `email` queue. The worker is pure transport — it does not
 * render. `EmailJob.template` therefore rides along as a label; the actual
 * subject/html/text travel inside `EmailJob.data` (the only free-form field on
 * the frozen `EmailJob` shape, which this section may not change).
 */

/**
 * The template set currently shipped. The full
 * set (due/overdue reminders, recurring-invoice-sent, contract-expiry,
 * subscription-payment-reminder) is deferred; these are the core transactional
 * + a generic notification-channel fallback.
 */
export const EMAIL_TEMPLATES = {
  invoiceSent: "invoice-sent",
  quoteSent: "quote-sent",
  passwordReset: "password-reset",
  emailVerification: "email-verification",
  genericNotification: "generic-notification",
} as const;

/** A template key (`"invoice-sent" | "quote-sent" | …`). */
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[keyof typeof EMAIL_TEMPLATES];

/** All template keys as a readonly array (for iteration/tests). */
export const EMAIL_TEMPLATE_LIST = Object.values(EMAIL_TEMPLATES) as readonly EmailTemplate[];

/** Template variables — free-form per template; values are stringified on render. */
export type TemplateData = Record<string, unknown>;

/**
 * A fully composed message: the render output the worker sends verbatim. HTML +
 * plain-text are both required (multipart/alternative).
 */
export interface ComposedMessage {
  /** Destination address. */
  to: string;
  /** Rendered subject line. */
  subject: string;
  /** Rendered HTML body. */
  html: string;
  /** Rendered plain-text fallback body. */
  text: string;
}

/**
 * The rendered payload carried inside `EmailJob.data`. The worker reads exactly
 * this off `job.data.data` to build the outgoing message.
 */
export interface RenderedEmailData {
  subject: string;
  html: string;
  text: string;
}

/**
 * The queue port `EmailService` depends on (DI seam). Deliberately narrower than
 * the concrete `QueueRegistry` (which has private fields a fake object literal
 * could not satisfy): the real registry is structurally assignable to this, and
 * tests can pass a trivial fake. The API **only enqueues** — it never sends
 * inline (worker isolation).
 */
export interface EmailQueuePort {
  enqueue(name: "email", payload: EmailJob, opts?: EnqueueOptions): Promise<string>;
}
