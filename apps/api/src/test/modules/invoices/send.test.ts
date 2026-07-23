import { describe, it, expect } from "vitest";
import type { Db } from "mongodb";
import { createLogger, AppError } from "@billy/shared";
import type { AuthContext, EmailJob } from "@billy/types";
import type { DomainEvent, DomainEventEmitter } from "@/platform/service.js";
import type { EnqueueOptions, QueueRegistry } from "@/platform/queue.js";
import { createInvoicesRouter } from "@/modules/invoices/routes.js";

/**
 * Router-level tests for the invoice /send + /send/preview endpoints (send-feature
 * spec, backend agent). Mirrors the public-links harness: build the real router
 * over a fake Db + a fake job queue, then drive a fake Koa ctx through
 * `router.routes()`. The fake queue captures enqueued jobs so we can assert the
 * email job carries the attachment ref + cc/bcc, and that a PDF render is enqueued
 * when no clean PDF exists.
 */

const logger = createLogger({ level: "silent", pretty: false, service: "test" });

const ADMIN: AuthContext = {
  userId: "u-admin",
  role: "administrator",
  capabilities: {
    canManageSettings: true,
    canManageUsers: true,
    canPermanentlyDelete: true,
    canViewFinancialTotals: true,
    canExportData: true,
  },
  accountId: "default",
};

// ── Fake job queue: captures enqueued jobs by name ────────────────────────────
interface Enqueued {
  name: string;
  payload: unknown;
  opts?: EnqueueOptions;
}
const fakeQueue = (): { queue: QueueRegistry; jobs: Enqueued[] } => {
  const jobs: Enqueued[] = [];
  const queue = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async enqueue(name: string, payload: unknown, opts?: EnqueueOptions): Promise<string> {
      jobs.push({ name, payload, opts });
      return `${name}:job-${jobs.length}`;
    },
  } as unknown as QueueRegistry;
  return { queue, jobs };
};

// ── Minimal in-memory Db: findOne + find().sort().limit().toArray() ───────────
type Doc = Record<string, unknown>;
const matches = (doc: Doc, filter: Doc): boolean => {
  return Object.entries(filter).every(([k, cond]) => {
    const v = doc[k];
    if (cond !== null && typeof cond === "object" && "$in" in (cond as Doc)) {
      return (((cond as Doc).$in as unknown[]) ?? []).includes(v);
    }
    if (cond !== null && typeof cond === "object" && "$ne" in (cond as Doc)) {
      return v !== (cond as Doc).$ne;
    }
    return v === cond;
  });
};
class FakeCollection {
  constructor(private readonly docs: Doc[]) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async findOne(filter: Doc): Promise<Doc | null> {
    return this.docs.find((d) => matches(d, filter)) ?? null;
  }
  find(filter: Doc) {
    let rows = this.docs.filter((d) => matches(d, filter));
    const cursor = {
      sort(spec: Record<string, 1 | -1>) {
        const [[key, dir] = ["createdAt", -1]] = Object.entries(spec);
        rows = [...rows].sort((a, b) => {
          const av = String(a[key] ?? "");
          const bv = String(b[key] ?? "");
          return av < bv ? -dir : av > bv ? dir : 0;
        });
        return cursor;
      },
      limit(n: number) {
        rows = rows.slice(0, n);
        return cursor;
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async toArray() {
        return rows;
      },
    };
    return cursor;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async countDocuments(filter: Doc): Promise<number> {
    return this.docs.filter((d) => matches(d, filter)).length;
  }
}
interface Store {
  invoices: Doc[];
  files: Doc[];
  clients: Doc[];
  settings: Doc[];
}
const fakeDb = (store: Store): Db => {
  const collections: Record<string, FakeCollection> = {
    invoices: new FakeCollection(store.invoices),
    files: new FakeCollection(store.files),
    clients: new FakeCollection(store.clients),
    settings: new FakeCollection(store.settings),
  };
  return {
    collection(name: string) {
      return (collections[name] ??= new FakeCollection([]));
    },
  } as unknown as Db;
};

const newEmitter = (): { emitter: DomainEventEmitter; events: DomainEvent[] } => {
  const events: DomainEvent[] = [];
  return { emitter: { emit: (e) => void events.push(e) }, events };
};

// ── Fake Koa ctx + driver ─────────────────────────────────────────────────────
interface FakeCtx {
  method: string;
  path: string;
  url: string;
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  request: { body?: unknown };
  headers: Record<string, string>;
  get(k: string): string;
  set(k: string, v: string): void;
  status: number;
  body: unknown;
  state: { authContext?: AuthContext };
}
const fakeCtx = (opts: {
  method: string;
  path: string;
  params: Record<string, string>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  auth?: AuthContext;
}): FakeCtx => {
  return {
    method: opts.method,
    path: opts.path,
    url: opts.path,
    params: opts.params,
    query: opts.query ?? {},
    request: { body: opts.body },
    headers: {},
    get() {
      return "";
    },
    set() {
      /* no-op */
    },
    status: 404,
    body: undefined,
    state: { authContext: opts.auth ?? ADMIN },
  };
};
const driver = (router: ReturnType<typeof createInvoicesRouter>) => {
  const dispatch = router.routes();
  return async (ctx: FakeCtx) =>
    dispatch(
      ctx as unknown as Parameters<typeof dispatch>[0],
      (async () => undefined) as unknown as Parameters<typeof dispatch>[1],
    );
};

// ── Fixtures ──────────────────────────────────────────────────────────────────
const BUSINESS: Doc = { key: "business", accountId: "default", data: { businessName: "Acme LLC" } };

const baseInvoice = (overrides: Doc = {}): Doc => {
  return {
    id: "inv-1",
    accountId: "default",
    version: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    clientId: "c-1",
    clientSnapshot: { clientId: "c-1", displayName: "Client Co", email: "client@example.com", currency: "EUR" },
    invoiceNumber: "INV-2026-0001",
    currency: "EUR",
    issueDate: "2026-01-01",
    dueDate: "2026-01-31",
    lineItems: [],
    subtotalMinor: 10000,
    discountMinor: 0,
    taxMinor: 0,
    grandTotalMinor: 10000,
    amountPaidMinor: 0,
    amountDueMinor: 10000,
    payments: [],
    status: "finalized",
    ...overrides,
  };
};
const cleanPdfFile = (overrides: Doc = {}): Doc => {
  return {
    id: "file-pdf-1",
    accountId: "default",
    ownerType: "invoice",
    ownerId: "inv-1",
    contentType: "application/pdf",
    filename: "INV-2026-0001.pdf",
    objectKey: "invoice/inv-1/abc",
    scanStatus: "clean",
    sizeBytes: 1234,
    createdAt: "2026-01-02T00:00:00.000Z",
    deletedAt: null,
    archivedAt: null,
  };
};

const build = (store: Store) => {
  const { queue, jobs } = fakeQueue();
  const { emitter } = newEmitter();
  const router = createInvoicesRouter({ db: fakeDb(store), emitter, logger, queue });
  return { drive: driver(router), jobs };
};

describe("POST /api/v1/invoices/:id/send", () => {
  it("enqueues an email job with the attachment ref + cc/bcc when a clean PDF exists", async () => {
    const store: Store = {
      invoices: [baseInvoice()],
      files: [cleanPdfFile()],
      clients: [],
      settings: [BUSINESS],
    };
    const { drive, jobs } = build(store);
    const ctx = fakeCtx({
      method: "POST",
      path: "/api/v1/invoices/inv-1/send",
      params: { id: "inv-1" },
      body: { version: 3, cc: ["cc@example.com"], bcc: ["bcc@example.com"] },
    });
    await drive(ctx);

    expect(ctx.status).toBe(200);
    const emailJobs = jobs.filter((j) => j.name === "email");
    expect(emailJobs).toHaveLength(1);
    const payload = emailJobs[0]!.payload as EmailJob;
    expect(payload.to).toBe("client@example.com");
    expect(payload.cc).toEqual(["cc@example.com"]);
    expect(payload.bcc).toEqual(["bcc@example.com"]);
    expect(payload.attachments).toEqual([{ fileId: "file-pdf-1", filename: "INV-2026-0001.pdf" }]);
    // No pdf render enqueued — a clean PDF already existed.
    expect(jobs.some((j) => j.name === "pdf")).toBe(false);
    expect((ctx.body as { data: { pdfPending: boolean } }).data.pdfPending).toBe(false);
  });

  it("enqueues a PDF render and returns pending (NO email) when no clean PDF exists yet", async () => {
    const store: Store = {
      invoices: [baseInvoice()],
      files: [], // no rendered PDF yet
      clients: [],
      settings: [BUSINESS],
    };
    const { drive, jobs } = build(store);
    const ctx = fakeCtx({
      method: "POST",
      path: "/api/v1/invoices/inv-1/send",
      params: { id: "inv-1" },
      body: { version: 3 },
    });
    await drive(ctx);

    // Mirrors pdf-generation's return-if-exists-else-render: with no clean PDF the
    // render is enqueued and the response is "pending" — a PDF-LESS email is NEVER
    // sent (the frontend re-invokes /send once the render lands).
    expect(ctx.status).toBe(200);
    expect(jobs.some((j) => j.name === "pdf")).toBe(true);
    expect(jobs.some((j) => j.name === "email")).toBe(false);
    const data = (ctx.body as { data: { status: string; pdfPending: boolean } }).data;
    expect(data.status).toBe("pending");
    expect(data.pdfPending).toBe(true);
  });

  it("rejects sending a DRAFT invoice (finalized-or-later gate)", async () => {
    const store: Store = {
      invoices: [baseInvoice({ status: "draft", invoiceNumber: null })],
      files: [],
      clients: [],
      settings: [BUSINESS],
    };
    const { drive, jobs } = build(store);
    const ctx = fakeCtx({
      method: "POST",
      path: "/api/v1/invoices/inv-1/send",
      params: { id: "inv-1" },
      body: { version: 3 },
    });
    const caught = await drive(ctx).then(
      () => undefined,
      (e: AppError) => e,
    );
    expect(caught).toBeInstanceOf(AppError);
    expect(caught!.code).toBe("INVALID_STATE_TRANSITION");
    expect(jobs).toHaveLength(0);
  });

  it("sends subject/body VERBATIM when supplied", async () => {
    const store: Store = {
      invoices: [baseInvoice()],
      files: [cleanPdfFile()],
      clients: [],
      settings: [BUSINESS],
    };
    const { drive, jobs } = build(store);
    const ctx = fakeCtx({
      method: "POST",
      path: "/api/v1/invoices/inv-1/send",
      params: { id: "inv-1" },
      body: { version: 3, subject: "Custom subject", body: "Custom body text" },
    });
    await drive(ctx);
    const payload = jobs.find((j) => j.name === "email")!.payload as EmailJob;
    const data = payload.data as { subject: string; html: string; text: string };
    expect(data.subject).toBe("Custom subject");
    expect(data.html).toBe("Custom body text");
    expect(data.text).toBe("Custom body text");
  });
});

describe("GET /api/v1/invoices/:id/send/preview", () => {
  it("returns the composed default { to, subject, html } for kind=invoice", async () => {
    const store: Store = {
      invoices: [baseInvoice()],
      files: [cleanPdfFile()],
      clients: [],
      settings: [BUSINESS],
    };
    const { drive } = build(store);
    const ctx = fakeCtx({
      method: "GET",
      path: "/api/v1/invoices/inv-1/send/preview",
      params: { id: "inv-1" },
      query: { kind: "invoice" },
    });
    await drive(ctx);
    expect(ctx.status).toBe(200);
    const data = (ctx.body as { data: { to: string; subject: string; html: string } }).data;
    expect(data.to).toBe("client@example.com");
    expect(data.subject).toContain("INV-2026-0001");
    expect(data.html).toContain("Acme LLC");
  });

  it("reminder kind composes a DIFFERENT default subject than invoice kind", async () => {
    const store: Store = {
      invoices: [baseInvoice()],
      files: [cleanPdfFile()],
      clients: [],
      settings: [BUSINESS],
    };
    const { drive } = build(store);
    const invoiceCtx = fakeCtx({
      method: "GET",
      path: "/api/v1/invoices/inv-1/send/preview",
      params: { id: "inv-1" },
      query: { kind: "invoice" },
    });
    const reminderCtx = fakeCtx({
      method: "GET",
      path: "/api/v1/invoices/inv-1/send/preview",
      params: { id: "inv-1" },
      query: { kind: "reminder" },
    });
    await drive(invoiceCtx);
    await drive(reminderCtx);
    const invoiceSubject = (invoiceCtx.body as { data: { subject: string } }).data.subject;
    const reminderSubject = (reminderCtx.body as { data: { subject: string } }).data.subject;
    expect(reminderSubject).not.toBe(invoiceSubject);
    expect(reminderSubject.toLowerCase()).toContain("reminder");
  });
});

describe("send routes without a queue (503 QUEUE_UNAVAILABLE)", () => {
  it("POST /send throws QUEUE_UNAVAILABLE when no queue is wired", async () => {
    const { emitter } = newEmitter();
    const store: Store = { invoices: [baseInvoice()], files: [], clients: [], settings: [BUSINESS] };
    // No queue → send routes must 503.
    const router = createInvoicesRouter({ db: fakeDb(store), emitter, logger });
    const drive = driver(router);
    const ctx = fakeCtx({
      method: "POST",
      path: "/api/v1/invoices/inv-1/send",
      params: { id: "inv-1" },
      body: { version: 3 },
    });
    const caught = await drive(ctx).then(
      () => undefined,
      (e: AppError) => e,
    );
    expect(caught).toBeInstanceOf(AppError);
    expect(caught!.code).toBe("QUEUE_UNAVAILABLE");
  });
});
