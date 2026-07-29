import type { Logger } from "@billy/shared";
import { QUEUE_NAME_LIST, type JobPayloads, type QueueName } from "@billy/types";
import { emailHandler } from "@/handlers/email.js";
import { pdfHandler } from "@/handlers/pdf.js";
import { pushHandler } from "@/handlers/push.js";
import { backupHandler } from "@/handlers/backup.js";
import { recurringTickHandler } from "@/handlers/recurring.js";

/**
 * Dependencies handed to every job handler. Kept minimal for the framework layer;
 * later worker sections (email/pdf/recurring) widen this (mailer, pdf engine, repos)
 * without changing the registry shape.
 */
export interface ProcessorContext {
  logger: Logger;
}

/**
 * A job handler for queue `Q`: receives the typed payload + shared context and
 * returns a JSON-serializable result (BullMQ stores it on the completed job).
 * The result type is `unknown` because each producing section defines its own.
 */
export type JobHandler<Q extends QueueName> = (
  payload: JobPayloads[Q],
  ctx: ProcessorContext,
) => Promise<unknown>;

/**
 * The processor registry: a map from queue name to its handler. This is the
 * single plug-in point — the email / pdf / recurring-scheduler worker sections
 * replace their stub here with a real handler; nothing else in the worker
 * changes. The mapped type keeps each handler's payload pinned to its queue.
 */
export type ProcessorRegistry = { [Q in QueueName]: JobHandler<Q> };

/**
 * Framework-stage handlers: log receipt of the job to prove the pipeline. The
 * `email` queue is now backed by the real send handler
 * (apps/worker/src/handlers/email.ts); the remaining entries are stubs the
 * owning section replaces.
 */
export function createProcessors(): ProcessorRegistry {
  return {
    // Email send handler (apps/worker/src/handlers/email.ts): builds a
    // nodemailer transport from SMTP_* env (jsonTransport in dev), sends, and
    // throws EMAIL_DELIVERY_FAILED on failure so BullMQ retries.
    email: emailHandler,
    // PDF render + store handler (apps/worker/src/handlers/pdf.ts): renders the
    // invoice/quote to A4 PDF via a single bounded Chromium (concurrency-capped),
    // stores it in MinIO "billy-files" + writes a FileObject; throws
    // PDF_GENERATION_FAILED on failure so BullMQ retries.
    pdf: pdfHandler,
    // Web Push send handler (apps/worker/src/handlers/push.ts): re-reads the
    // in-app notification doc for its rendered title/body, fans out to the
    // user's push subscriptions, prunes dead endpoints (410/404), and no-ops
    // gracefully when VAPID is not configured (never dead-letters for that).
    notifications: pushHandler,
    backup: backupHandler,
    cleanup: async (payload, ctx) => {
      ctx.logger.info({ queue: "cleanup", target: payload.target }, "processing cleanup job (stub)");
      return undefined;
    },
    // Scheduled-send + recurring tick (first worker→invoice-write path): finalizes
    // `scheduled` invoices whose date has arrived, under a system context.
    recurring: recurringTickHandler,
  };
}

/** All queue names covered by the registry (identical to the shared list). */
export const PROCESSOR_QUEUE_NAMES: readonly QueueName[] = QUEUE_NAME_LIST;
