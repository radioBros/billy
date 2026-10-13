import type { PassoSubmitBody } from "./types.js";

/** Error envelope PASSO returns: `{error:{code,message,retryable,details?},requestId}`. */
export class PassoError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PassoError";
  }

  /** Worth retrying automatically from billy's side. Duplicate-number 500s are NOT. */
  get transient(): boolean {
    if (this.status === 0) return true; // network / timeout before any answer
    if (this.status === 429 || this.status === 503 || this.status === 504) return true;
    return false;
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface PassoClientOptions {
  baseUrl: string;
  /** Tenant API key (Bearer). */
  apiKey?: string;
  /** Instance admin key (provisioning only; env, never stored). */
  adminKey?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface PassoNotification {
  type: string;
  receivedAt: string;
  acknowledgedAt?: string | null;
  errors?: { code: string; description?: string; gloss?: string; remedy?: string }[];
}
export interface PassoSubmission {
  submissionId: string;
  status: string;
  invoiceNumber?: string;
  progressivoInvio?: string;
  fileName?: string;
  channel?: string;
  channelRef?: string | null;
  identificativoSdI?: string | null;
  purgedAt?: string | null;
  nextAction?: string;
  terminal?: boolean;
  legallyIssued?: boolean;
  guidance?: string;
  notifications?: PassoNotification[];
}
export interface PassoAccepted {
  submissionId: string;
  status: string;
  invoiceNumber: string;
  progressivoInvio: string;
  fileName: string;
}
export interface PassoExport {
  submissionId: string;
  xml: string;
  hashes?: { xmlSha256?: string; recordedSha256?: string };
  rendered?: string | null;
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;

export class PassoClient {
  private readonly base: string;
  private readonly doFetch: FetchLike;
  constructor(private readonly opts: PassoClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/u, "");
    this.doFetch = opts.fetch ?? defaultFetch;
  }

  private async call<T>(
    method: string,
    path: string,
    auth: "tenant" | "admin",
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    raw = false,
  ): Promise<T> {
    const key = auth === "admin" ? this.opts.adminKey : this.opts.apiKey;
    if (!key) throw new PassoError(0, "BILLY_NO_CREDENTIALS", `PASSO ${auth} key is not configured`, false);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs ?? 20_000);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.doFetch(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          accept: raw ? "application/xml, application/json" : "application/json",
          ...extraHeaders,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ac.signal,
      });
    } catch (e) {
      throw new PassoError(0, "BILLY_NETWORK", e instanceof Error ? e.message : "network error", true);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (res.status >= 200 && res.status < 300) {
      if (raw) return text as T;
      return (text ? JSON.parse(text) : {}) as T;
    }
    let code = `HTTP_${res.status}`;
    let message = text.slice(0, 300);
    let retryable = false;
    let details: unknown;
    try {
      const j = JSON.parse(text) as { error?: { code?: string; message?: string; retryable?: boolean; details?: unknown } };
      if (j.error) {
        code = j.error.code ?? code;
        message = j.error.message ?? message;
        retryable = j.error.retryable === true;
        details = j.error.details;
      }
    } catch {
      /* non-JSON error body */
    }
    throw new PassoError(res.status, code, message, retryable, details);
  }

  // ── tenant routes ──────────────────────────────────────────────────────────
  submit(body: PassoSubmitBody, idempotencyKey: string): Promise<PassoAccepted> {
    return this.call("POST", "/api/v1/invoices", "tenant", body, { "idempotency-key": idempotencyKey });
  }
  get(submissionId: string): Promise<PassoSubmission> {
    return this.call("GET", `/api/v1/invoices/${encodeURIComponent(submissionId)}`, "tenant");
  }
  retry(submissionId: string): Promise<{ submissionId: string }> {
    return this.call("POST", `/api/v1/invoices/${encodeURIComponent(submissionId)}/retry`, "tenant", {});
  }
  exportInvoice(submissionId: string): Promise<PassoExport> {
    return this.call("GET", `/api/v1/invoices/${encodeURIComponent(submissionId)}/export`, "tenant");
  }
  ack(submissionId: string): Promise<{ acknowledged: number }> {
    return this.call("POST", `/api/v1/invoices/${encodeURIComponent(submissionId)}/ack`, "tenant", {});
  }
  /** Render an archived FatturaPA XML to HTML with the official AdE stylesheet. */
  async render(xml: string): Promise<string> {
    const key = this.opts.apiKey;
    if (!key) throw new PassoError(0, "BILLY_NO_CREDENTIALS", "PASSO tenant key is not configured", false);
    const res = await this.doFetch(`${this.base}/api/v1/render`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/xml", accept: "text/html" },
      body: xml,
    });
    const text = await res.text();
    if (res.status >= 300) throw new PassoError(res.status, `HTTP_${res.status}`, text.slice(0, 300), false);
    return text;
  }
  async createWebhook(callbackUrl: string, events: string[]): Promise<{ id: string; secret: string }> {
    const r = await this.call<{ id: string; secret: string }>("POST", "/api/v1/webhooks", "tenant", { callbackUrl, events });
    return { id: r.id, secret: r.secret };
  }
  deleteWebhook(id: string): Promise<unknown> {
    return this.call("DELETE", `/api/v1/webhooks/${encodeURIComponent(id)}`, "tenant");
  }

  // ── admin routes (provisioning) ────────────────────────────────────────────
  async createTenant(name: string, slug: string, transmitterCode: string): Promise<{ id: string }> {
    return this.call("POST", "/api/v1/admin/tenants", "admin", { name, slug, transmitterCode });
  }
  async createApiKey(tenantId: string, name: string, environment: "live" | "test"): Promise<{ id: string; key: string }> {
    return this.call("POST", `/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/api-keys`, "admin", {
      name,
      environment,
      scopes: ["invoices:read", "invoices:write", "webhooks:read", "webhooks:write"],
    });
  }
  async createSeller(
    tenantId: string,
    seller: { taxRegime: string; denomination: string; vatCountry: string; vatCode: string; taxCode?: string; address: Record<string, unknown> },
  ): Promise<{ id: string }> {
    return this.call("POST", `/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/sellers`, "admin", seller);
  }
  async putChannel(
    tenantId: string,
    channel: "pec" | "openapi" | "mock",
    config: Record<string, unknown>,
  ): Promise<{ channel: string; configured: boolean; inboundWebhookUrl?: string }> {
    return this.call("PUT", `/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/channels/${channel}`, "admin", config);
  }
  channelHealth(tenantId: string): Promise<{ channel?: string; ok: boolean; checked?: boolean; latencyMs?: number; error?: string }> {
    return this.call("GET", `/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/channels/health`, "admin");
  }
  /** Cheap authenticated probe used by "Test connection" for Manual mode. */
  async ping(): Promise<boolean> {
    await this.call("GET", "/api/v1/pending", "tenant");
    return true;
  }
}
