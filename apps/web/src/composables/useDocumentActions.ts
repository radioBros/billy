/**
 * useDocumentActions — the Preview / Print / Download logic for a single
 * document, factored out of DocumentActions.vue so both the detail-page buttons
 * and the table RowActionMenu reuse it.
 *
 * Endpoints (confirmed contract):
 *   GET /api/v1/<typePath>/:id/preview → { html }  (404 → RESOURCE_NOT_FOUND)
 *   GET /api/v1/<typePath>/:id/pdf     → { status:"ready", downloadUrl }
 *                                     OR { status:"pending", jobId }  (poll)
 *
 * The api client unwraps the success envelope's inner `data`, so we discriminate
 * on `data.status` — never on the HTTP status — and never need a raw-Response
 * fetch client.
 */
import { ref } from "vue";
import { api, ApiError } from "@/api/client";

export type DocumentType = "invoice" | "quote" | "proforma" | "credit-note" | "contract";

/** Map the domain type to its REST path segment. */
const TYPE_PATH: Record<DocumentType, string> = {
  invoice: "invoices",
  quote: "quotes",
  proforma: "proforma",
  "credit-note": "credit-notes",
  contract: "contracts",
};

interface PreviewResponse {
  html: string;
}
interface PdfReady {
  status: "ready";
  fileId: string;
  downloadUrl: string;
}
interface PdfPending {
  status: "pending";
  jobId: string;
}
type PdfResponse = PdfReady | PdfPending;

const POLL_INTERVAL_MS = 1000;
const POLL_MAX_TRIES = 30;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const withScreenPadding = (html: string): string => {
  const style = `<style media="screen">html,body{height:auto!important}body{padding:16mm 14mm!important;box-sizing:border-box!important}</style>`;
  if (/<\/head>/iu.test(html)) return html.replace(/<\/head>/iu, `${style}</head>`);
  return style + html;
};

export const useDocumentActions = (getType: () => DocumentType, getId: () => string) => {
  const previewOpen = ref(false);
  const previewHtml = ref<string>("");
  const previewLoading = ref(false);
  const downloading = ref(false);
  const errorMessage = ref<string | null>(null);

  function basePath(): string {
    return `/v1/${TYPE_PATH[getType()]}/${getId()}`;
  }

  /** Fetch the rendered HTML and open the preview dialog. */
  async function openPreview(): Promise<void> {
    errorMessage.value = null;
    previewLoading.value = true;
    previewOpen.value = true;
    try {
      const res = await api.get<PreviewResponse>(`${basePath()}/preview`);
      previewHtml.value = withScreenPadding(res.html);
    } catch (err) {
      previewOpen.value = false;
      errorMessage.value = err instanceof ApiError ? err.code : "PREVIEW_FAILED";
    } finally {
      previewLoading.value = false;
    }
  }

  /** Resolve the PDF: return-if-ready, else poll the pending job until ready. */
  async function resolvePdf(): Promise<PdfReady | null> {
    for (let tries = 0; tries < POLL_MAX_TRIES; tries++) {
      const res = await api.get<PdfResponse>(`${basePath()}/pdf`);
      if (res.status === "ready") return res;
      await delay(POLL_INTERVAL_MS);
    }
    return null; // timed out
  }

  /** Download the PDF (anchor-click the ready downloadUrl). Polls if pending. */
  async function download(): Promise<void> {
    errorMessage.value = null;
    downloading.value = true;
    try {
      const ready = await resolvePdf();
      if (!ready) {
        errorMessage.value = "PDF_TIMEOUT";
        return;
      }
      const a = document.createElement("a");
      a.href = ready.downloadUrl;
      a.rel = "noopener";
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      errorMessage.value = err instanceof ApiError ? err.code : "PDF_FAILED";
    } finally {
      downloading.value = false;
    }
  }

  return {
    previewOpen,
    previewHtml,
    previewLoading,
    downloading,
    errorMessage,
    openPreview,
    download,
    TYPE_PATH,
  };
};
