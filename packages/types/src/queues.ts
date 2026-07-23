/**
 * Shared background-jobs queue contract. The canonical list of the *finished*
 * system is 12 queues; this file freezes the framework foundation subset the
 * email / pdf / recurring-scheduler workers plug into first. It stays a pure-type
 * module so @billy/types remains dependency-free — no bullmq / ioredis import here.
 *
 * Producers (apps/api) enqueue by name via the QueueRegistry; consumers (apps/worker)
 * register one handler per name. Neither side redefines these names — this is the
 * single source of truth.
 */

/**
 * The queue names this framework layer ships. Each maps to a canonical queue
 * (the later full-topology work expands to all 12 — invoice/quote/contract/
 * subscription-status, push, maintenance):
 *   email         → `email`
 *   pdf           → `pdf`
 *   notifications → `notifications`
 *   backup        → `backup`
 *   cleanup       → `file-cleanup`
 *   recurring     → `recurring-billing` (repeatable-job owner)
 */
export const QUEUE_NAMES = {
  email: "email",
  pdf: "pdf",
  notifications: "notifications",
  backup: "backup",
  cleanup: "cleanup",
  recurring: "recurring",
} as const;

/** Union of the registered queue names (`"email" | "pdf" | …`). */
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** All queue names as a readonly array, for iterating when registering queues/workers. */
export const QUEUE_NAME_LIST = Object.values(QUEUE_NAMES) as readonly QueueName[];

// ── Job payloads (minimal shapes; string ids per contract) ───────────────────
// Each producing section owns the detail of its payload; these are the framework
// shapes the foundation carries. Ids are strings (Mongo ObjectId hex / uuid).

/** Send a transactional email (email-service worker). */
export interface EmailJob {
  /** Primary destination address. */
  to: string;
  /** Carbon-copy recipients. */
  cc?: string[];
  /** Blind carbon-copy recipients. */
  bcc?: string[];
  /** Reply-To address (defaults to the From address when absent). */
  replyTo?: string;
  /**
   * Attachment REFERENCES (never bytes — a Redis job must not carry PDF bytes).
   * The worker resolves each `fileId` to a `FileObject` → MinIO object → Buffer
   * at send time. A missing or not-yet-scan-clean file makes the job THROW so
   * BullMQ retries (a just-finalized document's PDF may still be rendering).
   */
  attachments?: { fileId: string; filename: string }[];
  /** Template key the email-service resolves to subject + body. */
  template: string;
  /** Template variables. */
  data?: Record<string, unknown>;
  /** Business/org scope (single-tenant self-host = the business id). */
  accountId: string;
}

/** Render a document to PDF (pdf-service worker; concurrency-capped). */
export interface PdfJob {
  /** Document kind driving the template. */
  documentType: "invoice" | "quote" | "proforma" | "credit-note" | "contract" | "receipt";
  /** Id of the entity to render. */
  documentId: string;
  accountId: string;
}

/** Deliver an in-app / channel notification (notification-engine worker). */
export interface NotificationJob {
  /** Recipient user id. */
  userId: string;
  /** Domain event type driving the template. */
  eventType: string;
  /** Entity the notification is about. */
  entityId: string;
  accountId: string;
}

/** Run a datastore backup (backup-restore worker; cron-driven). */
export interface BackupJob {
  /** Manual (admin-triggered) vs scheduled cron run. */
  trigger: "scheduled" | "manual";
  accountId: string;
}

/** Remove unreferenced / expired soft-deleted files (file-service worker). */
export interface CleanupJob {
  /** What to sweep. */
  target: "orphan-files" | "expired-sessions" | "expired-idempotency-keys";
  accountId: string;
}

/**
 * Execute one due recurring occurrence (recurring-scheduler worker). Carries the
 * occurrence coordinates the unique-index idempotency uses.
 */
export interface RecurringRunJob {
  /** Profile whose occurrence is due. */
  recurringProfileId: string;
  /** The scheduled occurrence date (ISO), part of the dedup key. */
  scheduledOccurrenceDate: string;
  accountId: string;
}

/**
 * Queue-name → payload map. The `_payloadsAreExhaustive` guard below makes this
 * exhaustive in both directions — a `QueueName` without a payload (or a payload
 * key that is not a queue name) is a compile error (mirrors the `satisfies`
 * exhaustiveness pattern on ERROR_STATUS in ./index.ts).
 */
export interface JobPayloads {
  email: EmailJob;
  pdf: PdfJob;
  notifications: NotificationJob;
  backup: BackupJob;
  cleanup: CleanupJob;
  recurring: RecurringRunJob;
}

// Compile-time guard that JobPayloads covers exactly the queue names.
const _payloadsAreExhaustive = QUEUE_NAMES satisfies Record<keyof JobPayloads, QueueName>;
void _payloadsAreExhaustive;
