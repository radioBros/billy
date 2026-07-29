/**
 * Email module barrel. Compose + enqueue side only — the
 * SMTP send lives in the worker (apps/worker/src/handlers/email.ts).
 *
 * INTEGRATION: build the service with the app's `QueueRegistry` (structurally
 * assignable to {@link EmailQueuePort}):
 *
 *   const emailService = new EmailService({ queue: queueRegistry, logger });
 *   await emailService.send({ to, template: "invoice-sent", data, accountId });
 *
 * Trigger sites (quotes/invoices/auth/notifications) call `send()`; it composes
 * and enqueues, and the worker delivers.
 */
export { EmailService } from "@/modules/email/service.js";
export type { EmailServiceDeps, SendInput } from "@/modules/email/service.js";
export {
  EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_LIST,
} from "@/modules/email/types.js";
export type {
  ComposedMessage,
  EmailQueuePort,
  EmailTemplate,
  RenderedEmailData,
  TemplateData,
} from "@/modules/email/types.js";
