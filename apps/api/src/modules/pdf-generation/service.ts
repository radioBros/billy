import type { AuthContext } from "@billy/types";
import type { QueueRegistry } from "@/platform/queue.js";

/**
 * PDF service (api side). The API **only enqueues** a `pdf`
 * job — it NEVER renders (no Playwright in the api process). The
 * actual render + MinIO store happens in the worker (apps/worker/src/handlers/
 * pdf.ts).
 *
 * Enqueue is idempotent on `[documentType, documentId]` so a double-submit (or a
 * route hit while a render is already queued) collapses to a single job
 * (via platform/queue buildJobId).
 */

export type PdfDocumentType = "invoice" | "quote" | "proforma" | "credit-note" | "contract";

export class PdfService {
  readonly #queue: QueueRegistry;

  constructor(queue: QueueRegistry) {
    this.#queue = queue;
  }

  /**
   * Enqueue a render of `documentType`/`documentId`. Returns the BullMQ job id
   * (deterministic via the idempotency key). `accountId` is carried from the
   * request auth context (single-tenant = the business id) as the PdfJob contract
   * requires it.
   */
  async enqueue(
    ctx: AuthContext,
    documentType: PdfDocumentType,
    documentId: string,
  ): Promise<{ jobId: string }> {
    const jobId = await this.#queue.enqueue(
      "pdf",
      { documentType, documentId, accountId: ctx.accountId },
      { idempotencyParts: [documentType, documentId] },
    );
    return { jobId };
  }
}
