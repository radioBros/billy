/**
 * E-invoicing (SdI) per-document API helpers + the polling loop.
 *
 * There is no realtime push for SdI status: after `submit`/`retry` the UI polls
 * `GET /:kind/:id/einvoice` every 2 s for up to 60 s (or until the document is no
 * longer in flight), then stops. `useEInvoicePolling` owns the timer and is torn
 * down with the component.
 */
import { onBeforeUnmount, ref } from "vue";
import { api, ApiError } from "@/api/client";
import type {
  EInvoiceInfo,
  EInvoiceKind,
  EInvoicePreflight,
  EInvoicePreflightIssue,
  EInvoiceStatus,
} from "@/types/domain";

export const POLL_INTERVAL_MS = 2000;
export const POLL_MAX_MS = 60_000;

const base = (kind: EInvoiceKind, id: string): string => `/v1/${kind}/${id}/einvoice`;

export const getEInvoice = (kind: EInvoiceKind, id: string): Promise<EInvoiceInfo> =>
  api.get<EInvoiceInfo>(base(kind, id));

export const runPreflight = (kind: EInvoiceKind, id: string): Promise<EInvoicePreflight> =>
  api.post<EInvoicePreflight>(`${base(kind, id)}/preflight`);

export const submitEInvoice = (kind: EInvoiceKind, id: string): Promise<{ status: EInvoiceStatus }> =>
  api.post<{ status: EInvoiceStatus }>(`${base(kind, id)}/submit`);

export const retryEInvoice = (kind: EInvoiceKind, id: string): Promise<{ status: EInvoiceStatus }> =>
  api.post<{ status: EInvoiceStatus }>(`${base(kind, id)}/retry`);

export const setSubmitOnFinalize = (kind: EInvoiceKind, id: string, submitOnFinalize: boolean): Promise<EInvoiceInfo> =>
  api.patch<EInvoiceInfo>(base(kind, id), { submitOnFinalize });

/** Open the archived XML / the AdE-style rendering (same-origin API, session cookie). */
export const einvoiceFileUrl = (kind: EInvoiceKind, id: string, what: "xml" | "rendered"): string =>
  `${base(kind, id)}/${what}`;

/** 409 EINVOICE_NOT_READY carries the preflight issues in `details` (array or `{issues}`). */
export const issuesFromError = (err: unknown): EInvoicePreflightIssue[] | null => {
  if (!(err instanceof ApiError) || !err.details) return null;
  const d = err.details as unknown;
  const list = Array.isArray(d) ? d : (d as { issues?: unknown }).issues;
  if (!Array.isArray(list)) return null;
  return list.filter(
    (i): i is EInvoicePreflightIssue => typeof i === "object" && i !== null && typeof (i as { code?: unknown }).code === "string",
  );
};

/** String-compare so codes not yet in the shared ErrorCode union still match. */
export const isApiCode = (err: unknown, code: string): boolean => err instanceof ApiError && String(err.code) === code;

/** Where a preflight "Fix" link goes (opened in a new tab). `null` ⇒ nothing to link to. */
export const fixHref = (issue: EInvoicePreflightIssue, clientId?: string | null): string | null => {
  switch (issue.fix) {
    case "client":
      return clientId ? `/clients/${clientId}/edit` : "/clients";
    case "business":
      return "/settings/customization/company";
    case "settings":
      return "/settings/customization/einvoicing";
    default:
      return null;
  }
};

export const useEInvoicePolling = () => {
  const polling = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let run = 0;

  const stop = (): void => {
    run += 1; // invalidates any pending tick
    if (timer) clearTimeout(timer);
    timer = null;
    polling.value = false;
  };

  /**
   * Poll until the document leaves the in-flight state or 60 s elapse. `onInfo`
   * receives every fresh snapshot; `onDone` fires once when polling ends.
   */
  const start = (
    kind: EInvoiceKind,
    id: string,
    onInfo: (info: EInvoiceInfo) => void,
    onDone?: (info: EInvoiceInfo | null) => void,
  ): void => {
    stop();
    const mine = run;
    const startedAt = Date.now();
    polling.value = true;
    let last: EInvoiceInfo | null = null;
    const finish = (): void => {
      if (mine !== run) return;
      polling.value = false;
      timer = null;
      onDone?.(last);
    };
    const tick = async (): Promise<void> => {
      if (mine !== run) return;
      try {
        last = await getEInvoice(kind, id);
        if (mine !== run) return;
        onInfo(last);
        if (!last.inFlight) return finish();
      } catch {
        // transient failure: keep trying until the window closes
      }
      if (Date.now() - startedAt >= POLL_MAX_MS) return finish();
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
  };

  onBeforeUnmount(stop);
  return { polling, start, stop };
};
