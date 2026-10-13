import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "mongodb";
import type { AuthContext } from "@billy/types";
import type { Logger } from "@billy/shared";
import { EInvoicingService } from "@/modules/einvoicing/service.js";
import type { QueueRegistry } from "@/platform/queue.js";

const KEY = "unit-test-data-encryption-key";

// ── tiny in-memory Mongo (equality, $in/$gte/$exists/$type, dotted $set) ──────
type Doc = Record<string, unknown>;
const get = (o: Doc, p: string): unknown => p.split(".").reduce<unknown>((a, k) => (a == null ? undefined : (a as Doc)[k]), o);
const match = (d: Doc, f: Doc): boolean =>
  Object.entries(f).every(([k, v]) => {
    if (k === "$or") return (v as Doc[]).some((sub) => match(d, sub));
    const val = get(d, k);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Doc;
      if ("$in" in o) return (o.$in as unknown[]).some((x) => x === val || (x === null && val === undefined));
      if ("$gte" in o) return val != null && (val as string) >= (o.$gte as string);
      if ("$exists" in o) return (val !== undefined) === o.$exists;
      if ("$type" in o) return typeof val === "string";
    }
    return val === v || (v === null && val === undefined);
  });
const setPath = (d: Doc, p: string, v: unknown): void => {
  const ks = p.split(".");
  let cur = d;
  ks.slice(0, -1).forEach((k) => (cur = (cur[k] ??= {}) as Doc));
  cur[ks[ks.length - 1]!] = v;
};
let store: Record<string, Doc[]>;
const db = {
  collection(name: string) {
    const rows = (store[name] ??= []);
    const q = (f: Doc) => rows.filter((r) => match(r, f));
    return {
      findOne: (f: Doc) => Promise.resolve(q(f)[0] ?? null),
      find: (f: Doc) => {
        let out = q(f);
        const c = { sort: () => c, limit: (n: number) => { out = out.slice(0, n); return c; }, toArray: () => Promise.resolve(out) };
        return c;
      },
      countDocuments: (f: Doc) => Promise.resolve(q(f).length),
      updateOne: (f: Doc, u: { $set?: Doc; $setOnInsert?: Doc }, o?: { upsert?: boolean }) => {
        let r = q(f)[0];
        if (!r && o?.upsert) { r = { ...f, ...(u.$setOnInsert ?? {}) }; rows.push(r); }
        if (r) for (const [k, v] of Object.entries(u.$set ?? {})) setPath(r, k, v);
        return Promise.resolve({});
      },
    };
  },
} as unknown as Db;

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
const ADMIN = { userId: "u1", accountId: "A", role: "administrator", capabilities: { canManageSettings: true } } as unknown as AuthContext;
const MEMBER = { userId: "u2", accountId: "A", role: "member", capabilities: { canManageSettings: false } } as unknown as AuthContext;

let enqueued: { name: string; payload: unknown }[];
const queue = { enqueue: (name: string, payload: unknown) => { enqueued.push({ name, payload }); return Promise.resolve("j1"); } } as unknown as QueueRegistry;

interface Call { method: string; url: string; body?: unknown }
let calls: Call[];
let passo: (c: Call) => { status: number; body: unknown };
const fetchImpl = (url: string, init: { method: string; body?: string }) => {
  const c: Call = { method: init.method, url: url.replace("http://passo:3000", ""), body: init.body ? JSON.parse(init.body) : undefined };
  calls.push(c);
  const r = passo(c);
  return Promise.resolve({ status: r.status, text: () => Promise.resolve(JSON.stringify(r.body)) });
};

let pecResult: { ok: boolean; smtp: { ok: boolean; message?: string }; imap: { ok: boolean; message?: string }; mail: { ok: boolean; message?: string } };
let pecCalls: { to: string }[];
const make = () =>
  new EInvoicingService({
    db, logger, queue, encryptionKey: KEY, fetchImpl: fetchImpl as never,
    pecTester: (_cfg, to) => { pecCalls.push({ to }); return Promise.resolve(pecResult); },
  });
const PEC = { smtpHost: "smtp.pec.it", smtpPort: 465, imapHost: "imap.pec.it", imapPort: 993, user: "me@pec.it", password: "hunter2" };
const business = { key: "business", accountId: "A", data: { businessName: "Fornitore", legalName: "Fornitore S.r.l.", vatNumber: "IT01234567890", taxCode: "01234567890", timezone: "Europe/Rome", bankAccounts: [{ id: "b", label: "Main", details: "x", iban: "IT60X0542811101000000123456" }], address: { line1: "Via Roma 12", city: "Milano", region: "MI", postalCode: "20100", country: "IT" } } };

beforeEach(() => {
  store = { settings: [{ ...business }], invoices: [], creditNotes: [], einvoiceSubmissions: [] };
  enqueued = [];
  calls = [];
  pecCalls = [];
  pecResult = { ok: true, smtp: { ok: true }, imap: { ok: true }, mail: { ok: true } };
  process.env.PASSO_ADMIN_KEY = "admin-key-with-at-least-24-chars!!";
  process.env.PASSO_API_URL = "http://passo:3000";
  delete process.env.PASSO_WEBHOOK_BASE_URL;
});

const finalized = (over: Doc = {}): Doc => ({
  id: "inv1", accountId: "A", deletedAt: null, status: "finalized", invoiceNumber: "9/2026", issueDate: new Date().toISOString().slice(0, 10), dueDate: "2099-01-01", currency: "EUR", grandTotalMinor: 122000,
  lineItems: [{ description: "Servizi", quantity: 1, unitPriceMinor: 100000, taxRate: 22, lineSubtotalMinor: 100000, lineDiscountMinor: 0, lineTaxMinor: 22000, lineTotalMinor: 122000 }],
  clientSnapshot: { type: "company", displayName: "Cli", legalName: "Cliente S.p.A.", vatNumber: "IT09876543210", recipientCode: "ABC1234", country: "IT", billingAddress: { line1: "Corso Italia 5", city: "Milano", region: "MI", postalCode: "20124", country: "IT" } },
  ...over,
});

describe("settings view / update", () => {
  it("is off by default and never leaks secrets", async () => {
    const svc = make();
    const v = await svc.view(ADMIN);
    expect(v).toMatchObject({ enabled: false, mode: "managed", connected: false, apiKeyConfigured: false, adminKeyAvailable: true, mockAllowed: true });
    await svc.update(ADMIN, { apiKey: "passo_live_supersecretvalue", passoSellerId: "s1", enabled: true });
    const v2 = (await svc.view(ADMIN)) as Record<string, unknown>;
    expect(v2).toMatchObject({ enabled: true, apiKeyConfigured: true, apiKeyLast4: "alue", connected: true });
    expect(JSON.stringify(v2)).not.toContain("supersecret");
    expect(Object.keys(v2)).not.toContain("apiKeyEnc");
    const stored = (store.settings!.find((s) => s.key === "einvoicing")!.data as Doc);
    expect(String(stored.apiKeyEnc)).toMatch(/^v1:/u);
    expect(typeof stored.enabledAt).toBe("string"); // stamped when first enabled
  });

  it("requires canManageSettings to write", async () => {
    await expect(make().update(MEMBER, { enabled: true })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
  });
});

describe("provision (managed)", () => {
  beforeEach(() => {
    passo = (c) => {
      if (c.url.endsWith("/admin/tenants")) return { status: 201, body: { id: "t1" } };
      if (c.url.endsWith("/api-keys")) return { status: 201, body: { id: "k1", key: "passo_test_abcdefghijklmnop" } };
      if (c.url.endsWith("/sellers")) return { status: 201, body: { id: "s1" } };
      return { status: 404, body: {} };
    };
  });

  it("creates tenant, key and seller once and is idempotent on re-run", async () => {
    const svc = make();
    const v = await svc.provision(ADMIN);
    expect(v).toMatchObject({ connected: true, passoTenantId: "t1", passoSellerId: "s1", apiKeyLast4: "mnop" });
    expect(calls.map((c) => c.url)).toEqual(["/api/v1/admin/tenants", "/api/v1/admin/tenants/t1/api-keys", "/api/v1/admin/tenants/t1/sellers"]);
    expect(calls[0]!.body).toMatchObject({ slug: "billy-a", transmitterCode: "01234567890" });
    calls = [];
    await svc.provision(ADMIN);
    expect(calls).toHaveLength(0);
    expect((await svc.view(ADMIN)).webhook).toMatchObject({ mode: "poll" });
  });

  it("refuses incomplete business data (the transmitter code is immutable in PASSO)", async () => {
    store.settings = [{ ...business, data: { ...business.data, vatNumber: null } }];
    await expect(make().provision(ADMIN)).rejects.toMatchObject({ code: "EINVOICE_BUSINESS_INCOMPLETE", details: { fields: ["vatNumber"] } });
    expect(calls).toHaveLength(0);
  });

  it("falls back to poll-only (does not fail) when the webhook cannot be registered", async () => {
    process.env.PASSO_WEBHOOK_BASE_URL = "https://billy.example.com";
    const base = passo;
    passo = (c) => (c.url.endsWith("/webhooks") ? { status: 400, body: { error: { code: "ERR_SCHEMA_INVALID", message: "callback resolves to a private address" } } } : base(c));
    const v = await make().provision(ADMIN);
    expect(v).toMatchObject({ connected: true, webhook: { mode: "poll" } });
    expect(String((v.webhook as { reason: string }).reason)).toContain("private address");
  });

  it("stores the webhook secret encrypted when registration works", async () => {
    process.env.PASSO_WEBHOOK_BASE_URL = "https://billy.example.com/";
    const base = passo;
    passo = (c) => (c.url.endsWith("/webhooks") ? { status: 201, body: { id: "w1", secret: "whsec_topsecret" } } : base(c));
    const svc = make();
    await svc.provision(ADMIN);
    expect(calls.find((c) => c.url.endsWith("/webhooks"))!.body).toMatchObject({ callbackUrl: "https://billy.example.com/public/einvoice/passo/A" });
    expect(await svc.webhookSecret("A")).toBe("whsec_topsecret");
    expect(JSON.stringify(await svc.view(ADMIN))).not.toContain("topsecret");
  });
});

describe("reset", () => {
  it("forgets the connection and switches off, but keeps the PASSO tenant/seller so reconnecting reuses them", async () => {
    passo = (c) => {
      if (c.url.endsWith("/admin/tenants")) return { status: 201, body: { id: "t1" } };
      if (c.url.endsWith("/api-keys")) return { status: 201, body: { id: "k", key: `passo_test_key${calls.length}abcdefgh` } };
      if (c.url.endsWith("/sellers")) return { status: 201, body: { id: "s1" } };
      return { status: 200, body: {} };
    };
    const svc = make();
    await svc.provision(ADMIN);
    await svc.update(ADMIN, { enabled: true });
    const v = await svc.reset(ADMIN);
    expect(v).toMatchObject({ enabled: false, connected: false, apiKeyConfigured: false, channel: null, passoTenantId: "t1", passoSellerId: "s1", enabledAt: null });
    calls = [];
    const again = await svc.provision(ADMIN); // only a fresh key; no new tenant/seller
    expect(calls.map((c) => c.url)).toEqual(["/api/v1/admin/tenants/t1/api-keys"]);
    expect(again).toMatchObject({ connected: true, passoTenantId: "t1" });
  });

  it("manual mode also forgets the pasted seller/tenant; needs canManageSettings", async () => {
    const svc = make();
    await svc.update(ADMIN, { mode: "manual", apiKey: "passo_live_x1234567", passoSellerId: "s9", enabled: true });
    expect(await svc.reset(ADMIN)).toMatchObject({ connected: false, passoSellerId: null });
    await expect(svc.reset(MEMBER)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
  });
});

describe("channel", () => {
  it("forwards secrets to PASSO but keeps only non-secret config", async () => {
    const svc = make();
    await svc.update(ADMIN, { apiKey: "passo_live_x1234567", passoSellerId: "s1" });
    await (svc as unknown as { saveSettings: (a: string, p: Doc) => Promise<unknown> }).saveSettings("A", { passoTenantId: "t1" });
    passo = () => ({ status: 200, body: { channel: "pec", configured: true } });
    await svc.testPec(ADMIN, { config: PEC, to: "me@example.com" });
    const out = await svc.putChannel(ADMIN, { type: "pec", config: PEC });
    expect(calls[0]!.body).toMatchObject({ password: "hunter2" });
    const ch = (out.view.channel as { publicConfig: Doc }).publicConfig;
    expect(ch).toMatchObject({ smtpHost: "smtp.pec.it", user: "me@pec.it" });
    expect(JSON.stringify(out.view)).not.toContain("hunter2");
    expect(ch.password).toBeUndefined();
  });
});

describe("PEC test gate", () => {
  const setup = async () => {
    const svc = make();
    await svc.update(ADMIN, { apiKey: "passo_live_x1234567", passoSellerId: "s1" });
    await (svc as unknown as { saveSettings: (a: string, p: Doc) => Promise<unknown> }).saveSettings("A", { passoTenantId: "t1" });
    passo = () => ({ status: 200, body: { channel: "pec", configured: true } });
    return svc;
  };

  it("refuses to save a PEC channel that was never tested, or was edited after the test", async () => {
    const svc = await setup();
    await expect(svc.putChannel(ADMIN, { type: "pec", config: PEC })).rejects.toMatchObject({ details: { channel: "pec.test_required" } });
    await svc.testPec(ADMIN, { config: PEC, to: "me@example.com" });
    await expect(svc.putChannel(ADMIN, { type: "pec", config: { ...PEC, password: "changed" } })).rejects.toMatchObject({ details: { channel: "pec.test_required" } });
    expect(calls).toHaveLength(0); // nothing reached PASSO
    await expect(svc.putChannel(ADMIN, { type: "pec", config: PEC })).resolves.toBeTruthy();
  });

  it("a failed test (SMTP, IMAP or the test email) never unlocks saving", async () => {
    const svc = await setup();
    pecResult = { ok: false, smtp: { ok: true }, imap: { ok: false, message: "login rejected" }, mail: { ok: true } };
    expect(await svc.testPec(ADMIN, { config: PEC, to: "me@example.com" })).toMatchObject({ ok: false });
    await expect(svc.putChannel(ADMIN, { type: "pec", config: PEC })).rejects.toMatchObject({ details: { channel: "pec.test_required" } });
  });

  it("never stores the password, refuses SdI addresses, and the test needs canManageSettings", async () => {
    const svc = await setup();
    await svc.testPec(ADMIN, { config: PEC, to: "me@example.com" });
    expect(JSON.stringify(store.settings)).not.toContain("hunter2");
    await expect(svc.testPec(ADMIN, { config: PEC, to: "sdi01@pec.fatturapa.it" })).rejects.toMatchObject({ details: { to: "pec.test_recipient_forbidden" } });
    await expect(svc.testPec(MEMBER, { config: PEC, to: "me@example.com" })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    expect(pecCalls).toHaveLength(1);
  });
});

describe("OpenAPI.it test gate", () => {
  const OA = { token: "oa_secret_token", baseUrl: "https://test.sdi.openapi.it" as const, requestSigning: false };
  let vendor: { status: number; body: unknown };
  const setup = async () => {
    const svc = make();
    await svc.update(ADMIN, { apiKey: "passo_live_x1234567", passoSellerId: "s1" });
    await (svc as unknown as { saveSettings: (a: string, p: Doc) => Promise<unknown> }).saveSettings("A", { passoTenantId: "t1" });
    vendor = { status: 200, body: { success: true, data: [{ fiscal_id: "01234567890", active: true, apply_signature: false }] } };
    passo = (c) => (c.url.includes("openapi.it") ? vendor : { status: 200, body: { channel: "openapi", configured: true, inboundWebhookUrl: "https://x/api/v1/inbound/pwh_1" } });
    return svc;
  };
  const fetchUrls = () => calls.map((c) => c.url);

  it("passes when the token works, the company is registered and signing agrees; saving then works once", async () => {
    const svc = await setup();
    await expect(svc.putChannel(ADMIN, { type: "openapi", config: OA })).rejects.toMatchObject({ details: { channel: "openapi.test_required" } });
    const r = await svc.testOpenapi(ADMIN, { config: OA });
    expect(r).toMatchObject({ ok: true, checks: [{ key: "token", ok: true }, { key: "registry", ok: true }, { key: "signing", ok: true }] });
    expect(fetchUrls().some((u) => u.includes("test.sdi.openapi.it/business_registry_configurations"))).toBe(true);
    const out = await svc.putChannel(ADMIN, { type: "openapi", config: OA });
    expect(out.inboundWebhookUrl).toBe("https://x/api/v1/inbound/pwh_1");
    expect(JSON.stringify(store.settings)).not.toContain("oa_secret_token");
    // editing anything (here the signing mode) re-locks
    await svc.testOpenapi(ADMIN, { config: OA });
    await expect(svc.putChannel(ADMIN, { type: "openapi", config: { ...OA, requestSigning: true } })).rejects.toMatchObject({ details: { channel: "openapi.test_required" } });
  });

  it("explains each failure: bad token, company not registered, signing mismatch", async () => {
    const svc = await setup();
    vendor = { status: 200, body: { success: false, message: "Wrong Token", error: 125.22, data: null } };
    expect(await svc.testOpenapi(ADMIN, { config: OA })).toMatchObject({ ok: false, checks: [{ key: "token", ok: false, message: "Wrong Token" }, { ok: false }, { ok: false }] });

    vendor = { status: 200, body: { success: true, data: [{ fiscal_id: "99999999999", active: true }] } };
    const noReg = await svc.testOpenapi(ADMIN, { config: OA });
    expect(noReg.checks.find((c) => c.key === "registry")).toMatchObject({ ok: false });

    vendor = { status: 200, body: { success: true, data: [{ fiscal_id: "01234567890", active: true, apply_signature: true }] } };
    const mismatch = await svc.testOpenapi(ADMIN, { config: OA });
    expect(mismatch.checks.find((c) => c.key === "signing")).toMatchObject({ ok: false, message: "the registry has signing ON" });
    await expect(svc.putChannel(ADMIN, { type: "openapi", config: OA })).rejects.toMatchObject({ details: { channel: "openapi.test_required" } });
  });
});

describe("document state / submit gating", () => {
  const connect = async (svc: EInvoicingService) => svc.update(ADMIN, { enabled: true, apiKey: "passo_live_x1234567", passoSellerId: "s1" });

  it("submit: 409 when disabled, not ready, or already sent; otherwise claims and enqueues", async () => {
    const svc = make();
    store.invoices = [finalized()];
    await expect(svc.submit(ADMIN, "invoice", "inv1")).rejects.toMatchObject({ code: "EINVOICE_DISABLED" });
    await connect(svc);

    store.invoices = [finalized({ clientSnapshot: { type: "company", displayName: "X", legalName: "X Srl", vatNumber: "IT09876543210", billingAddress: { line1: "Via 1", city: "Roma", region: "RM", postalCode: "00100", country: "IT" } } })];
    const e = (await svc.submit(ADMIN, "invoice", "inv1").catch((x: unknown) => x)) as { code: string; details: { issues: { code: string }[] } };
    expect(e).toMatchObject({ code: "EINVOICE_NOT_READY" });
    expect(e.details.issues.map((i) => i.code)).toContain("client.routing_missing");
    expect(enqueued).toHaveLength(0);

    store.invoices = [finalized()];
    expect(await svc.submit(ADMIN, "invoice", "inv1")).toEqual({ status: "queued" });
    expect(enqueued[0]).toMatchObject({ name: "einvoice", payload: { kind: "submit", accountId: "A", docKind: "invoice", docId: "inv1", trigger: "manual" } });
    expect((store.invoices![0]!.einvoice as Doc).status).toBe("queued");
    await expect(svc.submit(ADMIN, "invoice", "inv1")).rejects.toMatchObject({ code: "EINVOICE_ALREADY_SUBMITTED" });
  });

  it("is account-scoped: another account's invoice is not found", async () => {
    const svc = make();
    await connect(svc);
    store.invoices = [finalized({ accountId: "B" })];
    await expect(svc.state(ADMIN, "invoice", "inv1")).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("state reflects status, guidance, deadline and what actions are allowed", async () => {
    const svc = make();
    await connect(svc);
    store.invoices = [finalized({ issueDate: "2020-01-01" })];
    let s = await svc.state(ADMIN, "invoice", "inv1");
    expect(s).toMatchObject({ status: "not_sent", canSubmit: true, canRetry: false, legallyIssued: false, deadline: { overdue: true } });

    store.invoices = [finalized({ einvoice: { status: "awaiting_delivery", legallyIssued: true } })];
    s = await svc.state(ADMIN, "invoice", "inv1");
    expect(s).toMatchObject({ canSubmit: false, legallyIssued: true, inFlight: true, guidance: "issued_do_not_resubmit" });

    store.invoices = [finalized({ einvoice: { status: "failed", legallyIssued: false } })];
    s = await svc.state(ADMIN, "invoice", "inv1");
    expect(s).toMatchObject({ canRetry: true, canSubmit: false, guidance: "failed_retry" });

    store.invoices = [finalized({ einvoice: { status: "rejected", legallyIssued: false } })];
    expect((await svc.state(ADMIN, "invoice", "inv1")).guidance).toBe("rejected_reissue");
  });

  it("retry only for failed", async () => {
    const svc = make();
    await connect(svc);
    store.invoices = [finalized({ einvoice: { status: "delivered", legallyIssued: true } })];
    await expect(svc.retry(ADMIN, "invoice", "inv1")).rejects.toMatchObject({ code: "EINVOICE_ALREADY_SUBMITTED" });
    store.invoices = [finalized({ einvoice: { status: "failed" } })];
    await svc.retry(ADMIN, "invoice", "inv1");
    expect(enqueued[0]!.payload).toMatchObject({ kind: "retry", docId: "inv1" });
  });

  it("flag toggle only on draft/scheduled invoices", async () => {
    const svc = make();
    await connect(svc);
    store.invoices = [finalized({ status: "scheduled" })];
    expect((await svc.setSubmitOnFinalize(ADMIN, "inv1", true)).submitOnFinalize).toBe(true);
    store.invoices = [finalized()];
    await expect(svc.setSubmitOnFinalize(ADMIN, "inv1", true)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });
});

describe("preflight", () => {
  it("returns the recipient, and checks DRAFTS against the live client (no snapshot yet)", async () => {
    const svc = make();
    await svc.update(ADMIN, { enabled: true, apiKey: "passo_live_x1234567", passoSellerId: "s1" });
    store.clients = [{ id: "c1", accountId: "A", deletedAt: null, type: "company", displayName: "Cli", legalName: "Cliente S.p.A.", vatNumber: "IT09876543210", billingAddress: { line1: "Via 1", city: "Roma", region: "RM", postalCode: "00100", country: "IT" } }];
    store.invoices = [finalized({ status: "draft", invoiceNumber: null, clientSnapshot: undefined, clientId: "c1" })];
    const r = await svc.preflight(ADMIN, "invoice", "inv1");
    expect(r.ok).toBe(false);
    const codes = r.issues.map((i) => i.code);
    expect(codes).toContain("client.routing_missing"); // live client has no SDI code / PEC
    expect(codes).not.toContain("client.name_missing");
    expect(codes).toContain("invoice.not_finalized");
    expect(r.recipient).toMatchObject({ code: null, pec: null, name: "Cliente S.p.A.", foreign: false });
  });
});

describe("summary", () => {
  it("counts only documents issued since enablement, and flags problems separately", async () => {
    const svc = make();
    await svc.update(ADMIN, { enabled: true, apiKey: "passo_live_x1234567", passoSellerId: "s1" });
    const today = new Date().toISOString().slice(0, 10);
    store.invoices = [
      finalized({ id: "old", issueDate: "2001-01-01" }), // before enablement → ignored
      finalized({ id: "new1" }),
      finalized({ id: "bad", einvoice: { status: "rejected" } }),
      finalized({ id: "done", einvoice: { status: "delivered" } }), // not listed
    ];
    const s = (await svc.summary(ADMIN)) as { enabled: boolean; notSent: number; problems: number; items: { id: string; status: string }[] };
    expect(s).toMatchObject({ enabled: true, notSent: 1, problems: 1 });
    expect(s.items.map((i) => i.id).sort()).toEqual(["bad", "new1"]);
    expect(today).toBeTruthy();
  });

  it("is empty and cheap when disabled, but still exposes the UI defaults", async () => {
    expect(await make().summary(ADMIN)).toMatchObject({ enabled: false, items: [], offerStepAfterFinalize: true, scheduledDefaultSubmit: true, recurringDefaultSubmit: true });
  });
});
