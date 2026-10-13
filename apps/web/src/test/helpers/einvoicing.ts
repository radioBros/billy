/** Shared fixtures + a tiny fetch router for the e-invoicing UI tests. */
import { vi } from "vitest";
import type { EInvoiceInfo, EInvoicingSettings } from "@/types/domain";

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const ok = (data: unknown, status = 200): Response => jsonResponse({ data, meta: {}, error: null }, status);
export const fail = (code: string, status: number, details?: unknown): Response =>
  jsonResponse({ data: null, meta: {}, error: { code, message: code, details } }, status);

export const settingsView = (over: Partial<EInvoicingSettings> = {}): EInvoicingSettings => ({
  enabled: false,
  mode: "manual",
  apiBaseUrl: null,
  envApiUrl: "https://passo.example.test",
  adminKeyAvailable: false,
  connected: false,
  apiKeyConfigured: false,
  apiKeyLast4: null,
  passoTenantId: null,
  passoSellerId: null,
  passoTenantName: null,
  passoSellerName: null,
  webhook: { mode: "poll", reason: null },
  channel: null,
  taxRegime: "RF01",
  offerStepAfterFinalize: true,
  scheduledDefaultSubmit: false,
  recurringDefaultSubmit: false,
  defaultPaymentConditions: "TP02",
  defaultPaymentMethod: "MP05",
  defaultZeroRateNature: null,
  zeroRateLawReference: null,
  bollo: { mode: "auto", threshold: "77.47", amount: "2.00" },
  creditNoteNumberPrefix: "NC",
  sendDeadlineDays: 12,
  enabledAt: null,
  lastHealth: null,
  readiness: [
    { key: "business", ok: false, fix: "business" },
    { key: "iban", ok: false, fix: "business" },
    { key: "connection", ok: false, fix: "settings" },
    { key: "channel", ok: false, fix: "settings" },
  ],
  mockAllowed: false,
  ...over,
});

export const einvoiceInfo = (over: Partial<EInvoiceInfo> = {}): EInvoiceInfo => ({
  enabled: true,
  status: "not_sent",
  legallyIssued: false,
  inFlight: false,
  canSubmit: true,
  canRetry: false,
  submitOnFinalize: false,
  identificativoSdI: null,
  fileName: null,
  submittedAt: null,
  lastEventAt: null,
  lastError: null,
  guidance: "none",
  deadline: null,
  attempts: [],
  hasXml: false,
  ...over,
});

export interface RecordedCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

type Handler = (call: RecordedCall) => Response | Promise<Response> | undefined;

/**
 * Stub `fetch`: handlers are tried in order; the first to return a Response wins,
 * anything unmatched is an empty `{}` success. Returns the recorded calls.
 */
export const routeFetch = (...handlers: Handler[]): RecordedCall[] => {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      const call: RecordedCall = {
        method: (init?.method ?? "GET").toUpperCase(),
        path: url.replace(/^https?:\/\/[^/]+\/api/u, "").split("?")[0] ?? "",
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      };
      calls.push(call);
      for (const h of handlers) {
        const res = await h(call);
        if (res) return res;
      }
      return ok({});
    }),
  );
  return calls;
};

export const on =
  (method: string, path: string | RegExp, respond: (c: RecordedCall) => Response): Handler =>
  (call) =>
    call.method === method && (typeof path === "string" ? call.path === path : path.test(call.path)) ? respond(call) : undefined;

export const polyfillBrowser = (): void => {
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as unknown as { visualViewport?: unknown }).visualViewport ??= {
    width: 1024,
    height: 768,
    offsetLeft: 0,
    offsetTop: 0,
    scale: 1,
    addEventListener() {},
    removeEventListener() {},
  };
};
