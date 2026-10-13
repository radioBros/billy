import type { Db } from "mongodb";
import { AppError, type Logger } from "@billy/shared";
import type { AuthContext } from "@billy/types";
import { loadConfig } from "@billy/config";
import {
  PassoClient,
  PassoError,
  addDaysIso,
  canRetry as statusCanRetry,
  decryptSecret,
  encryptSecret,
  evaluateDocument,
  isConnected,
  isInFlight,
  isLegallyIssued,
  normalizeEInvoicingSettings,
  sendDeadline,
  splitVat,
  todayInZone,
  type DocKind,
  type EInvoiceStatus,
  type EInvoiceSubmissionDoc,
  type EInvoicingSettingsData,
  type PreflightIssue,
  type RawBusinessLike,
  type RawInvoiceLike,
} from "@billy/einvoice";
import { createHmac } from "node:crypto";
import { assertCapability } from "@/platform/service.js";
import { imapLoginCheck, isForbiddenTestRecipient, smtpCheckAndSend, type PecConfig, type PecTestResult } from "@/modules/einvoicing/pec-test.js";
import type { QueueRegistry } from "@/platform/queue.js";
import type { ChannelUpdateInput, EInvoicingSettingsUpdateInput, OpenapiTestInput, PecTestInput } from "@/modules/einvoicing/schema.js";

const SETTINGS = "settings";
export const SUBMISSIONS_COLLECTION = "einvoiceSubmissions";

/** Document statuses from which a document may be sent to SdI. */
const SENDABLE: Record<DocKind, readonly string[]> = {
  invoice: ["finalized", "sent", "partially_paid", "paid"],
  credit_note: ["issued"],
};
const collectionFor = (kind: DocKind): string => (kind === "credit_note" ? "creditNotes" : "invoices");

interface DocLike extends RawInvoiceLike {
  id: string;
  accountId: string;
  status: string;
  creditedInvoiceId?: string;
  clientSnapshot?: (RawInvoiceLike["clientSnapshot"] & { displayName: string }) | null;
  einvoice?: {
    status?: EInvoiceStatus;
    legallyIssued?: boolean;
    submitOnFinalize?: boolean;
    currentSubmissionId?: string | null;
    identificativoSdI?: string | null;
    fileName?: string | null;
    submittedAt?: string | null;
    lastEventAt?: string | null;
    lastError?: { code: string; message: string } | null;
  } | null;
  finalizedAt?: string | null;
  updatedAt?: string;
}

export type Guidance = "none" | "issued_do_not_resubmit" | "rejected_reissue" | "failed_retry" | "undelivered_tell_client";

const SECRET_KEYS = /pass|token|secret|key/iu;

export interface EInvoicingServiceDeps {
  db: Db;
  queue?: QueueRegistry;
  logger: Logger;
  /** Overridable for tests. */
  encryptionKey?: string;
  fetchImpl?: ConstructorParameters<typeof PassoClient>[0]["fetch"];
  /** Overridable for tests (real impl talks SMTP/IMAP). */
  pecTester?: (cfg: PecConfig, to: string) => Promise<PecTestResult>;
}

export class EInvoicingService {
  private readonly db: Db;
  private readonly queue?: QueueRegistry;
  private readonly logger: Logger;
  private readonly key: string;
  private readonly fetchImpl?: EInvoicingServiceDeps["fetchImpl"];
  private readonly pecTester: (cfg: PecConfig, to: string) => Promise<PecTestResult>;

  constructor(deps: EInvoicingServiceDeps) {
    this.db = deps.db;
    this.queue = deps.queue;
    this.logger = deps.logger;
    this.key = deps.encryptionKey ?? loadConfig().DATA_ENCRYPTION_KEY;
    this.fetchImpl = deps.fetchImpl;
    this.pecTester =
      deps.pecTester ??
      (async (cfg, to) => {
        const [imap, sm] = await Promise.all([
          imapLoginCheck(cfg),
          smtpCheckAndSend(cfg, to, "Billy PEC test", "This is a test message sent by Billy to verify the PEC mailbox you are connecting for e-invoicing. No action is needed."),
        ]);
        return { ok: imap.ok && sm.smtp.ok && sm.mail.ok, smtp: sm.smtp, imap, mail: sm.mail };
      });
  }

  /** Fingerprint of a tested OpenAPI.it config (keyed HMAC; the token is never stored). */
  private openapiHash(c: { token: string; baseUrl: string; requestSigning: boolean }): string {
    return createHmac("sha256", this.key).update(JSON.stringify([c.token, c.baseUrl, c.requestSigning])).digest("hex");
  }

  // ── OpenAPI.it pre-flight: token + seller registry + signing ─────────────────
  /**
   * Reads the vendor's business registries with the pasted token (no submission, nothing billed
   * beyond a read) and checks the three things that break every submission otherwise:
   * the token works, THIS company's VAT number is registered (error 661 otherwise) and the
   * registry's `apply_signature` agrees with the chosen signing mode (error 387 otherwise).
   */
  async testOpenapi(ctx: AuthContext, input: OpenapiTestInput): Promise<{ ok: boolean; checks: { key: "token" | "registry" | "signing"; ok: boolean; message?: string }[] }> {
    assertCapability(ctx, "canManageSettings");
    const { token, baseUrl, requestSigning } = input.config;
    const biz = await this.loadBusiness(ctx.accountId);
    const vat = biz.vatNumber ? splitVat(biz.vatNumber, "IT") : null;
    const checks: { key: "token" | "registry" | "signing"; ok: boolean; message?: string }[] = [];
    const doFetch = this.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit) as never);
    type RegistryRow = { fiscal_id?: string; active?: boolean; apply_signature?: boolean };
    let rows: RegistryRow[] | null = null;
    try {
      const res = await doFetch(`${baseUrl}/business_registry_configurations`, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
      const text = await res.text();
      let body: { success?: boolean; message?: string; data?: unknown } | null = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* non-JSON */
      }
      // The vendor's envelope overrides the HTTP status (success:false can arrive with a 200).
      if (res.status >= 300 || !body || body.success === false) {
        checks.push({ key: "token", ok: false, message: (body?.message ?? `HTTP ${res.status}`).toString().slice(0, 160) });
      } else {
        rows = Array.isArray(body.data) ? (body.data as RegistryRow[]) : [];
        checks.push({ key: "token", ok: true });
      }
    } catch (e) {
      checks.push({ key: "token", ok: false, message: e instanceof Error ? e.message.slice(0, 160) : "unreachable" });
    }
    if (rows === null) {
      checks.push({ key: "registry", ok: false, message: "not checked" }, { key: "signing", ok: false, message: "not checked" });
    } else {
      const mine = vat ? rows.find((r) => (r.fiscal_id ?? "").replace(/^IT/iu, "") === vat.code && r.active !== false) : undefined;
      checks.push(mine ? { key: "registry", ok: true } : { key: "registry", ok: false, message: vat ? `no active registry for ${vat.code}` : "company VAT number missing" });
      if (!mine || typeof mine.apply_signature !== "boolean") {
        checks.push({ key: "signing", ok: Boolean(mine), ...(mine ? {} : { message: "not checked" }) });
      } else {
        checks.push(mine.apply_signature === requestSigning ? { key: "signing", ok: true } : { key: "signing", ok: false, message: `the registry has signing ${mine.apply_signature ? "ON" : "OFF"}` });
      }
    }
    const ok = checks.every((c) => c.ok);
    this.logger.info({ accountId: ctx.accountId, ok, checks: checks.map((c) => `${c.key}:${c.ok}`) }, "einvoicing OpenAPI.it test");
    await this.saveSettings(ctx.accountId, { openapiTest: ok ? { hash: this.openapiHash(input.config), at: new Date().toISOString() } : null });
    return { ok, checks };
  }

  /** Fingerprint of a tested PEC config (keyed HMAC; the password is never stored). */
  private pecHash(cfg: PecConfig): string {
    return createHmac("sha256", this.key).update(JSON.stringify([cfg.smtpHost, cfg.smtpPort, cfg.imapHost, cfg.imapPort, cfg.user, cfg.password])).digest("hex");
  }

  // ── PEC pre-flight: connection test + a real test email ──────────────────────
  /**
   * Verifies SMTP login, IMAP login, and SENDS a test message to `to` from the PEC mailbox.
   * A pass is remembered (as a keyed hash of the config) so `putChannel` can require it: a PEC
   * channel can only be saved with the exact config that just passed, within 30 minutes.
   */
  async testPec(ctx: AuthContext, input: PecTestInput): Promise<PecTestResult> {
    assertCapability(ctx, "canManageSettings");
    if (isForbiddenTestRecipient(input.to)) {
      throw new AppError("VALIDATION_FAILED", "Use your own address, not an SdI address", { details: { to: "pec.test_recipient_forbidden" } });
    }
    const result = await this.pecTester(input.config, input.to);
    this.logger.info({ accountId: ctx.accountId, ok: result.ok, smtp: result.smtp.ok, imap: result.imap.ok, mail: result.mail.ok }, "einvoicing PEC test");
    await this.saveSettings(ctx.accountId, { pecTest: result.ok ? { hash: this.pecHash(input.config), at: new Date().toISOString(), to: input.to } : null });
    return result;
  }

  // ── Settings storage ─────────────────────────────────────────────────────────
  async loadSettings(accountId: string): Promise<EInvoicingSettingsData> {
    const doc = (await this.db.collection(SETTINGS).findOne({ key: "einvoicing", accountId } as never, { projection: { _id: 0 } })) as
      | { data?: Partial<EInvoicingSettingsData> }
      | null;
    return normalizeEInvoicingSettings(doc?.data);
  }

  private async saveSettings(accountId: string, patch: Partial<EInvoicingSettingsData>): Promise<EInvoicingSettingsData> {
    const current = await this.loadSettings(accountId);
    const merged: EInvoicingSettingsData = { ...current, ...patch, bollo: { ...current.bollo, ...(patch.bollo ?? {}) } };
    const ts = new Date().toISOString();
    await this.db.collection(SETTINGS).updateOne(
      { key: "einvoicing", accountId } as never,
      {
        $set: { data: merged, updatedAt: ts },
        $inc: { version: 1 },
        $setOnInsert: { key: "einvoicing", accountId, id: crypto.randomUUID().replace(/-/gu, "").slice(0, 24), createdAt: ts, archivedAt: null, deletedAt: null },
      } as never,
      { upsert: true },
    );
    return merged;
  }

  private async loadBusiness(accountId: string): Promise<RawBusinessLike & { timezone?: string | null; bankAccounts?: { iban?: string | null }[] }> {
    const doc = (await this.db.collection(SETTINGS).findOne({ key: "business", accountId } as never, { projection: { _id: 0 } })) as
      | { data?: RawBusinessLike & { timezone?: string | null; bankAccounts?: { iban?: string | null }[] } }
      | null;
    return doc?.data ?? { businessName: "" };
  }

  private apiBaseUrl(s: EInvoicingSettingsData): string | null {
    return s.apiBaseUrl || loadConfig().PASSO_API_URL || null;
  }

  private tenantClient(s: EInvoicingSettingsData): PassoClient | null {
    const base = this.apiBaseUrl(s);
    if (!base || !s.apiKeyEnc) return null;
    try {
      return new PassoClient({ baseUrl: base, apiKey: decryptSecret(s.apiKeyEnc, this.key), ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}) });
    } catch {
      return null;
    }
  }

  private adminClient(s: EInvoicingSettingsData): PassoClient {
    const cfg = loadConfig();
    const base = this.apiBaseUrl(s);
    if (!cfg.PASSO_ADMIN_KEY) throw new AppError("EINVOICE_ADMIN_KEY_MISSING", "PASSO admin key is not configured on this server");
    if (!base) throw new AppError("VALIDATION_FAILED", "PASSO URL is required", { details: { apiBaseUrl: "field.required" } });
    return new PassoClient({
      baseUrl: base,
      adminKey: cfg.PASSO_ADMIN_KEY,
      ...(s.apiKeyEnc ? { apiKey: decryptSecret(s.apiKeyEnc, this.key) } : {}),
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
  }

  private unreachable(e: unknown): AppError {
    if (e instanceof PassoError) return new AppError("EINVOICE_PASSO_UNREACHABLE", `PASSO: ${e.code} ${e.message}`.slice(0, 300));
    return new AppError("EINVOICE_PASSO_UNREACHABLE", "PASSO is unreachable");
  }

  // ── Settings view / update ───────────────────────────────────────────────────
  async view(ctx: AuthContext): Promise<Record<string, unknown>> {
    const s = await this.loadSettings(ctx.accountId);
    const biz = await this.loadBusiness(ctx.accountId);
    const cfg = loadConfig();
    const connected = isConnected(s, cfg.PASSO_API_URL);
    const bizIssues = this.businessMissing(biz);
    return {
      enabled: s.enabled,
      mode: s.mode,
      apiBaseUrl: s.apiBaseUrl ?? null,
      envApiUrl: cfg.PASSO_API_URL ?? null,
      adminKeyAvailable: Boolean(cfg.PASSO_ADMIN_KEY),
      connected,
      apiKeyConfigured: Boolean(s.apiKeyEnc),
      apiKeyLast4: s.apiKeyLast4 ?? null,
      passoTenantId: s.passoTenantId ?? null,
      passoSellerId: s.passoSellerId ?? null,
      // Human-readable identities (the ids above are opaque UUIDs, shown only as a tooltip).
      passoTenantName: s.passoTenantId ? (s.passoTenantName ?? (s.mode === "managed" ? this.companyLabel(biz) : null)) : null,
      passoSellerName: s.passoSellerId ? (s.passoSellerName ?? (s.mode === "managed" ? this.companyLabel(biz) : null)) : null,
      webhook: { mode: s.webhookMode, reason: s.webhookReason ?? null },
      channel: s.channel ?? null,
      taxRegime: s.taxRegime,
      offerStepAfterFinalize: s.offerStepAfterFinalize,
      scheduledDefaultSubmit: s.scheduledDefaultSubmit,
      recurringDefaultSubmit: s.recurringDefaultSubmit,
      defaultPaymentConditions: s.defaultPaymentConditions,
      defaultPaymentMethod: s.defaultPaymentMethod,
      defaultZeroRateNature: s.defaultZeroRateNature ?? null,
      zeroRateLawReference: s.zeroRateLawReference ?? null,
      bollo: s.bollo,
      creditNoteNumberPrefix: s.creditNoteNumberPrefix,
      sendDeadlineDays: s.sendDeadlineDays,
      enabledAt: s.enabledAt ?? null,
      lastHealth: s.lastHealth ?? null,
      mockAllowed: !cfg.isProd,
      // Ordered setup checklist (i18n: einvoicing.readiness.<key>).
      readiness: [
        { key: "business", ok: bizIssues.length === 0, fix: "business" as const },
        { key: "iban", ok: (biz.bankAccounts ?? []).some((b) => Boolean(b.iban)), fix: "business" as const },
        { key: "connection", ok: connected, fix: "settings" as const },
        { key: "channel", ok: s.mode === "manual" ? connected : Boolean(s.channel), fix: "settings" as const },
      ],
    };
  }

  async update(ctx: AuthContext, input: EInvoicingSettingsUpdateInput): Promise<Record<string, unknown>> {
    assertCapability(ctx, "canManageSettings");
    const { apiKey, passoSellerId, ...rest } = input;
    const patch: Partial<EInvoicingSettingsData> = { ...rest } as Partial<EInvoicingSettingsData>;
    const current = await this.loadSettings(ctx.accountId);
    if (apiKey !== undefined) {
      patch.apiKeyEnc = encryptSecret(apiKey, this.key);
      patch.apiKeyLast4 = apiKey.slice(-4);
    }
    if (passoSellerId !== undefined) patch.passoSellerId = passoSellerId;
    if (input.enabled === true && !current.enabled) {
      patch.enabledAt = new Date().toISOString();
    }
    await this.saveSettings(ctx.accountId, patch);
    return this.view(ctx);
  }

  /** "Fornitore S.r.l. · P.IVA IT01234567890" — what a person recognises. */
  private companyLabel(b: RawBusinessLike): string {
    const name = (b.legalName || b.businessName || "").trim();
    return [name, b.vatNumber ? `P.IVA ${b.vatNumber.trim()}` : ""].filter(Boolean).join(" · ");
  }

  /** Missing/invalid business fields that block provisioning (the transmitter code is immutable in PASSO). */
  private businessMissing(b: RawBusinessLike): string[] {
    const missing: string[] = [];
    if (!(b.legalName || b.businessName)?.trim()) missing.push("name");
    if (!b.vatNumber || !splitVat(b.vatNumber, "IT")) missing.push("vatNumber");
    const a = b.address;
    if (!a?.line1?.trim()) missing.push("address.line1");
    if (!a?.city?.trim()) missing.push("address.city");
    if (!/^\d{5}$/u.test((a?.postalCode ?? "").trim())) missing.push("address.postalCode");
    if (!/^[A-Za-z]{2}$/u.test((a?.region ?? "").trim())) missing.push("address.region");
    return missing;
  }

  // ── Reset ────────────────────────────────────────────────────────────────────
  /**
   * Start the stepped setup over: switch sending OFF and forget the local connection (API key,
   * channel, webhook, health). Documents and their SdI history are untouched. In managed mode the
   * PASSO tenant + seller are KEPT (PASSO cannot delete or change them; the transmitter identity is
   * immutable), so reconnecting reuses them instead of creating duplicates; manual mode forgets the
   * pasted seller id too.
   */
  async reset(ctx: AuthContext): Promise<Record<string, unknown>> {
    assertCapability(ctx, "canManageSettings");
    const s = await this.loadSettings(ctx.accountId);
    // Best-effort: stop PASSO calling a webhook we are about to forget.
    if (s.webhookId) {
      try {
        await this.tenantClient(s)?.deleteWebhook(s.webhookId);
      } catch {
        /* the secret is dropped locally anyway; deliveries to it would be rejected */
      }
    }
    await this.saveSettings(ctx.accountId, {
      enabled: false,
      enabledAt: null,
      apiKeyEnc: null,
      apiKeyLast4: null,
      webhookId: null,
      webhookSecretEnc: null,
      webhookMode: "poll",
      webhookReason: null,
      channel: null,
      lastHealth: null,
      ...(s.mode === "manual" ? { passoSellerId: null, passoTenantId: null } : {}),
    });
    this.logger.info({ accountId: ctx.accountId, userId: ctx.userId }, "einvoicing connection reset");
    return this.view(ctx);
  }

  // ── Managed provisioning ─────────────────────────────────────────────────────
  async provision(ctx: AuthContext): Promise<Record<string, unknown>> {
    assertCapability(ctx, "canManageSettings");
    const accountId = ctx.accountId;
    let s = await this.loadSettings(accountId);
    const biz = await this.loadBusiness(accountId);
    const missing = this.businessMissing(biz);
    if (missing.length > 0) {
      throw new AppError("EINVOICE_BUSINESS_INCOMPLETE", "Complete the company data first", { details: { fields: missing } });
    }
    const admin = this.adminClient(s);
    const vat = splitVat(biz.vatNumber!, "IT")!;
    const cfg = loadConfig();
    try {
      if (!s.passoTenantId) {
        const slug = `billy-${accountId}`.toLowerCase().replace(/[^a-z0-9-]/gu, "-").slice(0, 60);
        // Transmitter identity (IdTrasmittente) = the company VAT number; immutable once created in PASSO.
        const t = await admin.createTenant((biz.legalName || biz.businessName).slice(0, 100), slug, (vat.code || biz.taxCode?.trim() || "").toUpperCase());
        s = await this.saveSettings(accountId, { passoTenantId: t.id, passoTenantName: this.companyLabel(biz), apiBaseUrl: this.apiBaseUrl(s) });
      }
      if (!s.apiKeyEnc) {
        const k = await admin.createApiKey(s.passoTenantId!, "billy", cfg.isProd ? "live" : "test");
        s = await this.saveSettings(accountId, { apiKeyEnc: encryptSecret(k.key, this.key), apiKeyLast4: k.key.slice(-4) });
      }
      if (!s.passoSellerId) {
        const a = biz.address!;
        const seller = await admin.createSeller(s.passoTenantId!, {
          taxRegime: s.taxRegime,
          denomination: (biz.legalName || biz.businessName).slice(0, 80),
          vatCountry: vat.country,
          vatCode: vat.code,
          ...(biz.taxCode ? { taxCode: biz.taxCode.trim().toUpperCase() } : {}),
          address: { street: a.line1, postalCode: a.postalCode, city: a.city, province: (a.region ?? "").toUpperCase(), country: (a.country ?? "IT").toUpperCase() },
        });
        s = await this.saveSettings(accountId, { passoSellerId: seller.id, passoSellerName: this.companyLabel(biz) });
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      this.logger.warn({ accountId, err: e instanceof Error ? e.message : e }, "einvoicing provision failed");
      throw this.unreachable(e);
    }

    // Webhook is an optional accelerator; a failure must NOT fail provisioning (poll-only mode).
    if (!s.webhookId) {
      s = await this.registerWebhook(accountId, s);
    }
    return this.view(ctx);
  }

  private async registerWebhook(accountId: string, s: EInvoicingSettingsData): Promise<EInvoicingSettingsData> {
    const base = loadConfig().PASSO_WEBHOOK_BASE_URL;
    if (!base) return this.saveSettings(accountId, { webhookMode: "poll", webhookReason: "PASSO_WEBHOOK_BASE_URL is not set" });
    const client = this.tenantClient(s);
    if (!client) return s;
    try {
      const hook = await client.createWebhook(`${base.replace(/\/+$/u, "")}/public/einvoice/passo/${accountId}`, [
        "invoice.delivered",
        "invoice.rejected",
        "invoice.exception",
        "invoice.transmitted_undelivered",
        "invoice.accepted_by_pa",
        "invoice.rejected_by_pa",
        "submission.failed",
      ]);
      return this.saveSettings(accountId, { webhookId: hook.id, webhookSecretEnc: encryptSecret(hook.secret, this.key), webhookMode: "webhook", webhookReason: null });
    } catch (e) {
      const reason = e instanceof PassoError ? `${e.code}: ${e.message}`.slice(0, 200) : "webhook registration failed";
      this.logger.info({ accountId, reason }, "einvoicing webhook not registered — poll-only");
      return this.saveSettings(accountId, { webhookMode: "poll", webhookReason: reason });
    }
  }

  // ── Channel (managed only; secrets forwarded to PASSO, never stored) ─────────
  async putChannel(ctx: AuthContext, input: ChannelUpdateInput): Promise<{ view: Record<string, unknown>; inboundWebhookUrl?: string }> {
    assertCapability(ctx, "canManageSettings");
    const s = await this.loadSettings(ctx.accountId);
    if (!s.passoTenantId) throw new AppError("EINVOICE_NOT_CONNECTED", "Connect to PASSO first");
    if (input.type === "mock" && loadConfig().isProd) {
      throw new AppError("VALIDATION_FAILED", "The mock channel is not available in production", { details: { type: "channel.mock_forbidden" } });
    }
    if (input.type === "pec") {
      const t = s.pecTest;
      const fresh = t && Date.now() - Date.parse(t.at) < 30 * 60_000;
      if (!fresh || t.hash !== this.pecHash(input.config)) {
        throw new AppError("VALIDATION_FAILED", "Test the PEC connection (and the test email) before saving", { details: { channel: "pec.test_required" } });
      }
    }
    if (input.type === "openapi") {
      const t = s.openapiTest;
      const fresh = t && Date.now() - Date.parse(t.at) < 30 * 60_000;
      if (!fresh || t.hash !== this.openapiHash(input.config)) {
        throw new AppError("VALIDATION_FAILED", "Test the OpenAPI.it connection before saving", { details: { channel: "openapi.test_required" } });
      }
    }
    const admin = this.adminClient(s);
    let result;
    try {
      result = await admin.putChannel(s.passoTenantId, input.type, input.config as Record<string, unknown>);
    } catch (e) {
      throw this.unreachable(e);
    }
    const publicConfig: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(input.config)) {
      if (SECRET_KEYS.test(k) && k !== "requestSigning") continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") publicConfig[k] = v;
    }
    await this.saveSettings(ctx.accountId, { pecTest: null, openapiTest: null, channel: { type: input.type, configuredAt: new Date().toISOString(), publicConfig } });
    return { view: await this.view(ctx), ...(result.inboundWebhookUrl ? { inboundWebhookUrl: result.inboundWebhookUrl } : {}) };
  }

  // ── Connection test ──────────────────────────────────────────────────────────
  async test(ctx: AuthContext): Promise<{ ok: boolean; checks: { key: string; ok: boolean; message?: string }[] }> {
    assertCapability(ctx, "canManageSettings");
    const s = await this.loadSettings(ctx.accountId);
    const checks: { key: string; ok: boolean; message?: string }[] = [];
    const client = this.tenantClient(s);
    if (!client) {
      checks.push({ key: "api", ok: false, message: "not configured" }, { key: "key", ok: false, message: "not configured" });
    } else {
      try {
        await client.ping();
        checks.push({ key: "api", ok: true }, { key: "key", ok: true });
      } catch (e) {
        const authFail = e instanceof PassoError && (e.status === 401 || e.status === 403);
        const msg = e instanceof Error ? e.message.slice(0, 200) : "unreachable";
        // 401/403 means PASSO answered (API reachable) but rejected the key.
        checks.push({ key: "api", ok: authFail, ...(authFail ? {} : { message: msg }) }, { key: "key", ok: false, message: authFail ? "API key rejected" : "unchecked" });
      }
    }
    if (s.mode === "managed" && s.passoTenantId && loadConfig().PASSO_ADMIN_KEY) {
      try {
        const h = await this.adminClient(s).channelHealth(s.passoTenantId);
        checks.push({ key: "channel", ok: h.ok === true, ...(h.ok ? {} : { message: h.error ?? "channel not healthy" }) });
      } catch (e) {
        checks.push({ key: "channel", ok: false, message: e instanceof Error ? e.message.slice(0, 200) : "error" });
      }
    } else {
      checks.push({ key: "channel", ok: s.mode === "manual" ? Boolean(client) : false, ...(s.mode === "manual" ? {} : { message: "not configured" }) });
    }
    checks.push({ key: "webhook", ok: true, message: s.webhookMode === "webhook" ? "webhook" : (s.webhookReason ?? "poll") });
    const ok = checks.every((c) => c.ok);
    await this.saveSettings(ctx.accountId, { lastHealth: { ok, checkedAt: new Date().toISOString(), message: ok ? null : checks.filter((c) => !c.ok).map((c) => c.key).join(", ") } });
    return { ok, checks };
  }

  // ── Documents ────────────────────────────────────────────────────────────────
  private async loadDoc(ctx: AuthContext, kind: DocKind, id: string): Promise<DocLike> {
    const doc = (await this.db.collection(collectionFor(kind)).findOne({ id, accountId: ctx.accountId, deletedAt: null } as never, { projection: { _id: 0 } })) as DocLike | null;
    if (!doc) throw new AppError("RESOURCE_NOT_FOUND", "Document not found");
    // Drafts/scheduled documents have no frozen snapshot yet: preflight against the live client so
    // the user can fix routing data BEFORE issuing.
    if (!doc.clientSnapshot) {
      const cid = (doc as { clientId?: string }).clientId;
      const c = cid
        ? ((await this.db.collection("clients").findOne({ id: cid, accountId: ctx.accountId, deletedAt: null } as never, { projection: { _id: 0 } })) as RawInvoiceLike["clientSnapshot"] | null)
        : null;
      if (c) doc.clientSnapshot = c as DocLike["clientSnapshot"];
    }
    if (kind === "credit_note" && doc.creditedInvoiceId) {
      const inv = (await this.db.collection("invoices").findOne({ id: doc.creditedInvoiceId, accountId: ctx.accountId } as never, { projection: { _id: 0, invoiceNumber: 1, issueDate: 1 } })) as
        | { invoiceNumber?: string; issueDate?: string }
        | null;
      doc.creditedInvoiceNumber = inv?.invoiceNumber ?? doc.creditedInvoiceNumber ?? null;
      doc.creditedIssueDate = inv?.issueDate ?? null;
    }
    return doc;
  }

  private async evaluate(ctx: AuthContext, kind: DocKind, doc: DocLike, s: EInvoicingSettingsData) {
    const biz = await this.loadBusiness(ctx.accountId);
    return evaluateDocument({
      kind,
      doc,
      business: biz,
      settings: s,
      envApiUrl: loadConfig().PASSO_API_URL ?? null,
      today: todayInZone(biz.timezone ?? "Europe/Rome"),
      docFinalizedAt: doc.finalizedAt ?? null,
      crmInvoiceRef: `billy:${ctx.accountId}:${doc.id}`,
    });
  }

  async preflight(
    ctx: AuthContext,
    kind: DocKind,
    id: string,
  ): Promise<{ ok: boolean; issues: PreflightIssue[]; bolloMinor: number; recipient: { code: string | null; pec: string | null; name: string; foreign: boolean } }> {
    const s = await this.loadSettings(ctx.accountId);
    const doc = await this.loadDoc(ctx, kind, id);
    const r = await this.evaluate(ctx, kind, doc, s);
    const issues = [...r.issues];
    if (!SENDABLE[kind].includes(doc.status)) {
      issues.unshift({ code: "invoice.not_finalized", severity: "error", fix: "invoice" });
    }
    const c = doc.clientSnapshot;
    const country = (c?.billingAddress?.country ?? c?.country ?? "IT").toString().toUpperCase().slice(0, 2);
    return {
      ok: r.ok && SENDABLE[kind].includes(doc.status),
      issues,
      bolloMinor: r.bolloMinor,
      recipient: {
        code: c?.recipientCode?.trim() ? c.recipientCode.trim().toUpperCase() : null,
        pec: c?.pecEmail?.trim() || null,
        name: (c?.legalName || c?.displayName || "").trim(),
        foreign: country !== "IT",
      },
    };
  }

  private guidance(status: EInvoiceStatus): Guidance {
    switch (status) {
      case "awaiting_delivery":
      case "accepted_by_pa":
      case "delivered":
        return "issued_do_not_resubmit";
      case "rejected":
        return "rejected_reissue";
      case "failed":
        return "failed_retry";
      case "undelivered_attested":
        return "undelivered_tell_client";
      case "rejected_by_pa":
        return "issued_do_not_resubmit";
      default:
        return "none";
    }
  }

  async state(ctx: AuthContext, kind: DocKind, id: string): Promise<Record<string, unknown>> {
    const s = await this.loadSettings(ctx.accountId);
    const doc = await this.loadDoc(ctx, kind, id);
    const e = doc.einvoice ?? null;
    const status: EInvoiceStatus = e?.status ?? "not_sent";
    const subs = (await this.db
      .collection<EInvoiceSubmissionDoc>(SUBMISSIONS_COLLECTION)
      .find({ accountId: ctx.accountId, docKind: kind, docId: id } as never, { projection: { _id: 0, xml: 0 } })
      .sort({ attempt: 1 })
      .toArray()) as Omit<EInvoiceSubmissionDoc, "xml">[];
    const latestXml = await this.db.collection(SUBMISSIONS_COLLECTION).countDocuments({ accountId: ctx.accountId, docKind: kind, docId: id, xml: { $type: "string" } } as never);
    const biz = await this.loadBusiness(ctx.accountId);
    const today = todayInZone(biz.timezone ?? "Europe/Rome");
    const sendable = SENDABLE[kind].includes(doc.status);
    const connected = isConnected(s, loadConfig().PASSO_API_URL);
    const dl = sendable ? sendDeadline(doc.issueDate, s.sendDeadlineDays, today) : null;
    return {
      enabled: s.enabled,
      status,
      legallyIssued: Boolean(e?.legallyIssued) || isLegallyIssued(status),
      inFlight: isInFlight(status),
      canSubmit: s.enabled && connected && sendable && (status === "not_sent" || status === "blocked"),
      canRetry: s.enabled && connected && statusCanRetry(status),
      submitOnFinalize: Boolean(e?.submitOnFinalize),
      identificativoSdI: e?.identificativoSdI ?? null,
      fileName: e?.fileName ?? null,
      submittedAt: e?.submittedAt ?? null,
      lastEventAt: e?.lastEventAt ?? null,
      lastError: e?.lastError ?? null,
      guidance: this.guidance(status),
      deadline: dl
        ? { dueBy: dl.dueBy, overdue: dl.overdue && (status === "not_sent" || status === "blocked"), finalizedBeforeEnable: Boolean(s.enabledAt && doc.finalizedAt && doc.finalizedAt < s.enabledAt) }
        : null,
      attempts: subs.map((a) => ({
        attempt: a.attempt,
        at: a.createdAt,
        status: a.status,
        receipts: (a.receipts ?? []).map((r) => ({ type: r.type, receivedAt: r.receivedAt, ...(r.errors?.length ? { errors: r.errors } : {}) })),
      })),
      hasXml: latestXml > 0,
    };
  }

  private requireQueue(): QueueRegistry {
    if (!this.queue) throw new AppError("QUEUE_UNAVAILABLE", "Job queue is not available");
    return this.queue;
  }

  async submit(ctx: AuthContext, kind: DocKind, id: string, trigger: "manual" | "creation_step" = "manual"): Promise<{ status: EInvoiceStatus }> {
    const s = await this.loadSettings(ctx.accountId);
    if (!s.enabled) throw new AppError("EINVOICE_DISABLED", "E-invoicing is not enabled");
    const doc = await this.loadDoc(ctx, kind, id);
    const status: EInvoiceStatus = doc.einvoice?.status ?? "not_sent";
    if (status !== "not_sent" && status !== "blocked") {
      throw new AppError("EINVOICE_ALREADY_SUBMITTED", "This document was already sent to SdI", { details: { status } });
    }
    if (!SENDABLE[kind].includes(doc.status)) {
      throw new AppError("EINVOICE_NOT_READY", "Only finalized documents can be sent to SdI", { details: { issues: [{ code: "invoice.not_finalized", severity: "error", fix: "invoice" }] } });
    }
    const r = await this.evaluate(ctx, kind, doc, s);
    if (!r.ok) throw new AppError("EINVOICE_NOT_READY", "The document is not ready for SdI", { details: { issues: r.issues } });
    const now = new Date().toISOString();
    await this.db.collection(collectionFor(kind)).updateOne(
      { id, accountId: ctx.accountId } as never,
      { $set: { "einvoice.status": "queued", "einvoice.legallyIssued": false, "einvoice.lastError": null, "einvoice.lastEventAt": now, updatedAt: now } } as never,
    );
    await this.requireQueue().enqueue(
      "einvoice",
      { kind: "submit", accountId: ctx.accountId, docKind: kind, docId: id, trigger },
      { idempotencyParts: ["submit", kind, id, String(Date.now())] },
    );
    return { status: "queued" };
  }

  async retry(ctx: AuthContext, kind: DocKind, id: string): Promise<{ status: EInvoiceStatus }> {
    const s = await this.loadSettings(ctx.accountId);
    if (!s.enabled) throw new AppError("EINVOICE_DISABLED", "E-invoicing is not enabled");
    const doc = await this.loadDoc(ctx, kind, id);
    if (!statusCanRetry(doc.einvoice?.status ?? "not_sent")) {
      throw new AppError("EINVOICE_ALREADY_SUBMITTED", "Only a failed submission can be retried", { details: { status: doc.einvoice?.status ?? "not_sent" } });
    }
    await this.requireQueue().enqueue("einvoice", { kind: "retry", accountId: ctx.accountId, docKind: kind, docId: id }, { idempotencyParts: ["retry", kind, id, String(Date.now())] });
    return { status: "queued" };
  }

  /** Scheduled invoices: toggle "send via SdI when issued". */
  async setSubmitOnFinalize(ctx: AuthContext, id: string, value: boolean): Promise<Record<string, unknown>> {
    const doc = await this.loadDoc(ctx, "invoice", id);
    if (doc.status !== "scheduled" && doc.status !== "draft") {
      throw new AppError("INVALID_STATE_TRANSITION", "Only a draft or scheduled invoice can change this");
    }
    await this.db.collection("invoices").updateOne(
      { id, accountId: ctx.accountId } as never,
      { $set: { "einvoice.submitOnFinalize": value, "einvoice.status": doc.einvoice?.status ?? "not_sent", "einvoice.legallyIssued": false, updatedAt: new Date().toISOString() } } as never,
    );
    return this.state(ctx, "invoice", id);
  }

  async xml(ctx: AuthContext, kind: DocKind, id: string): Promise<{ xml: string; fileName: string }> {
    await this.loadDoc(ctx, kind, id);
    const row = (await this.db
      .collection<EInvoiceSubmissionDoc>(SUBMISSIONS_COLLECTION)
      .find({ accountId: ctx.accountId, docKind: kind, docId: id, xml: { $type: "string" } } as never, { projection: { _id: 0 } })
      .sort({ attempt: -1 })
      .limit(1)
      .toArray())[0];
    if (!row?.xml) throw new AppError("RESOURCE_NOT_FOUND", "No archived XML for this document");
    return { xml: row.xml, fileName: row.fileName ?? `${id}.xml` };
  }

  /** Render the archived XML with the official AdE stylesheet (PASSO `/render` is stateless). */
  async rendered(ctx: AuthContext, kind: DocKind, id: string): Promise<string> {
    const { xml } = await this.xml(ctx, kind, id);
    const s = await this.loadSettings(ctx.accountId);
    const client = this.tenantClient(s);
    if (!client) throw new AppError("EINVOICE_NOT_CONNECTED", "Connect to PASSO first");
    try {
      return await client.render(xml);
    } catch (e) {
      throw this.unreachable(e);
    }
  }

  /** Dashboard action list: finalized documents (after enablement) not yet sent, plus ones needing attention. */
  async summary(ctx: AuthContext): Promise<Record<string, unknown>> {
    const s = await this.loadSettings(ctx.accountId);
    // Defaults the (possibly non-admin) UI needs to pre-set its switches.
    const defaults = { offerStepAfterFinalize: s.offerStepAfterFinalize, scheduledDefaultSubmit: s.scheduledDefaultSubmit, recurringDefaultSubmit: s.recurringDefaultSubmit };
    if (!s.enabled) return { enabled: false, notSent: 0, overdue: 0, problems: 0, items: [], ...defaults };
    const biz = await this.loadBusiness(ctx.accountId);
    const today = todayInZone(biz.timezone ?? "Europe/Rome");
    const since = (s.enabledAt ?? "").slice(0, 10);
    const items: Record<string, unknown>[] = [];
    let notSent = 0;
    let overdue = 0;
    let problems = 0;
    for (const kind of ["invoice", "credit_note"] as const) {
      const rows = (await this.db
        .collection(collectionFor(kind))
        .find(
          {
            accountId: ctx.accountId,
            deletedAt: null,
            status: { $in: SENDABLE[kind] },
            ...(since ? { issueDate: { $gte: since } } : {}),
            $or: [{ "einvoice.status": { $exists: false } }, { "einvoice.status": { $in: ["not_sent", "blocked", "failed", "rejected"] } }],
          } as never,
          { projection: { _id: 0, id: 1, invoiceNumber: 1, creditNoteNumber: 1, issueDate: 1, clientSnapshot: 1, einvoice: 1 } },
        )
        .sort({ issueDate: 1 })
        .limit(200)
        .toArray()) as unknown as DocLike[];
      for (const d of rows) {
        const st: EInvoiceStatus = d.einvoice?.status ?? "not_sent";
        const dl = sendDeadline(d.issueDate, s.sendDeadlineDays, today);
        const isProblem = st === "failed" || st === "rejected" || st === "blocked";
        if (st === "not_sent") notSent += 1;
        else problems += 1;
        if (dl.overdue && (st === "not_sent" || st === "blocked")) overdue += 1;
        if (items.length < 50) {
          items.push({
            kind,
            id: d.id,
            number: (kind === "credit_note" ? d.creditNoteNumber : d.invoiceNumber) ?? "",
            clientName: d.clientSnapshot?.displayName ?? "",
            issueDate: d.issueDate,
            dueBy: addDaysIso(d.issueDate, s.sendDeadlineDays),
            overdue: dl.overdue && !isProblem ? true : dl.overdue && (st === "not_sent" || st === "blocked"),
            status: st,
          });
        }
      }
    }
    return { enabled: true, notSent, overdue, problems, items, ...defaults };
  }

  // ── Webhook (accelerator) ────────────────────────────────────────────────────
  async webhookSecret(accountId: string): Promise<string | null> {
    const s = await this.loadSettings(accountId);
    if (!s.webhookSecretEnc) return null;
    try {
      return decryptSecret(s.webhookSecretEnc, this.key);
    } catch {
      return null;
    }
  }

  /** Called after a verified webhook: kick an immediate sync for the matching submission. */
  async onWebhook(accountId: string, passoSubmissionId: string | undefined): Promise<void> {
    if (!this.queue) return;
    let submissionId: string | undefined;
    if (passoSubmissionId) {
      const row = (await this.db.collection(SUBMISSIONS_COLLECTION).findOne({ accountId, passoSubmissionId } as never, { projection: { _id: 0, id: 1 } })) as { id?: string } | null;
      submissionId = row?.id;
    }
    await this.queue.enqueue(
      "einvoice",
      { kind: "sync", accountId, ...(submissionId ? { submissionId } : {}) },
      { idempotencyParts: ["sync-hook", accountId, submissionId ?? "all", String(Math.floor(Date.now() / 5000))] },
    );
  }
}
