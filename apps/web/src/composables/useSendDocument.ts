/**
 * useSendDocument — the preview-load + send logic for emailing a single
 * document (invoice or contract), factored out of SendDocumentModal.vue so the
 * modal stays a thin view (mirrors the useDocumentActions shape).
 *
 * Endpoints (CONFIRMED BACKEND CONTRACT, commit 4cb2130):
 *   GET  /api/v1/<typePath>/:id/send/preview?kind=<kind>
 *        → { to, subject, html }   (api client unwraps the envelope to this)
 *   POST /api/v1/<typePath>/:id/send
 *        body: { to, cc:[], bcc:[], subject, body, kind }
 *        headers: If-Match version (optimistic-concurrency guard)
 *        → one of TWO shapes the caller MUST handle:
 *          • { status:"queued",  emailJobId, pdfPending:false } — email on its way
 *          • { status:"pending", pdfJobId,   pdfPending:true  } — PDF still rendering,
 *            NO email sent; user should retry Send in a moment.
 *        503 QUEUE_UNAVAILABLE if the queue is down.
 *
 * The api client unwraps the success envelope's inner `data` and throws
 * `ApiError` (carrying `error.code`) on any failure — so we discriminate the
 * send outcome on `data.status`, never on the HTTP status.
 */
import { ref } from "vue";
import { api, ApiError } from "@/api/client";

/** Documents that can be emailed via this feature. */
export type SendDocumentType = "invoice" | "contract";

/** `invoice` = the document email; `reminder` = the reminder template variant. */
export type SendKind = "invoice" | "reminder";

/** Map the domain type to its REST path segment. */
const TYPE_PATH: Record<SendDocumentType, string> = {
  invoice: "invoices",
  contract: "contracts",
};

export interface SendPreview {
  to: string;
  subject: string;
  html: string;
}

interface SendQueued {
  status: "queued";
  emailJobId?: string;
  pdfPending?: false;
}
interface SendPending {
  status: "pending";
  pdfJobId?: string;
  pdfPending: true;
}
type SendResponse = SendQueued | SendPending;

export interface SendPayload {
  to: string;
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  kind: SendKind;
}

/** Outcome the modal reacts to (snackbar + open/close), or an error code. */
export type SendOutcome =
  | { kind: "queued" }
  | { kind: "pending" }
  | { kind: "error"; code: string };

export const useSendDocument = (getType: () => SendDocumentType, getId: () => string) => {
  const previewLoading = ref(false);
  const sending = ref(false);
  const loadError = ref<string | null>(null);

  function basePath(): string {
    return `/v1/${TYPE_PATH[getType()]}/${getId()}`;
  }

  /** Load the server-rendered default email (to/subject/html) for the modal. */
  async function loadPreview(kind: SendKind): Promise<SendPreview | null> {
    loadError.value = null;
    previewLoading.value = true;
    try {
      return await api.get<SendPreview>(`${basePath()}/send/preview`, { kind });
    } catch (err) {
      loadError.value = err instanceof ApiError ? err.code : "PREVIEW_FAILED";
      return null;
    } finally {
      previewLoading.value = false;
    }
  }

  /**
   * POST the (edited) email. Returns a normalized outcome the modal maps to a
   * snackbar; throwing is avoided so the caller has one branch to switch on.
   */
  async function send(payload: SendPayload, version?: number): Promise<SendOutcome> {
    sending.value = true;
    try {
      const res = await api.post<SendResponse>(`${basePath()}/send`, payload, {
        ifMatch: version,
      });
      if (res.status === "pending") return { kind: "pending" };
      return { kind: "queued" };
    } catch (err) {
      return { kind: "error", code: err instanceof ApiError ? err.code : "SEND_FAILED" };
    } finally {
      sending.value = false;
    }
  }

  return {
    previewLoading,
    sending,
    loadError,
    loadPreview,
    send,
    TYPE_PATH,
  };
};
