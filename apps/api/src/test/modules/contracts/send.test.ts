import { describe, it, expect } from "vitest";
import type { Db } from "mongodb";
import { createLogger, AppError } from "@billy/shared";
import type { AuthContext, EmailJob } from "@billy/types";
import type { DomainEvent, DomainEventEmitter } from "@/platform/service.js";
import type { EnqueueOptions, QueueRegistry } from "@/platform/queue.js";
import { createContractsRouter } from "@/modules/contracts/routes.js";

/**
 * Router-level tests for the contract /send + /send/preview endpoints (send-feature
 * spec). Same shape as the invoice send tests, but permissive gate (any non-deleted
 * contract) and ownerType "contract" for the attached PDF. Client email is resolved
 * from the `clients` collection (contracts carry only a clientId, no snapshot).
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
  contracts: Doc[];
  files: Doc[];
  clients: Doc[];
  settings: Doc[];
}
const fakeDb = (store: Store): Db => {
  const collections: Record<string, FakeCollection> = {
    contracts: new FakeCollection(store.contracts),
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
    state: { authContext: ADMIN },
  };
};
const driver = (router: ReturnType<typeof createContractsRouter>) => {
  const dispatch = router.routes();
  return async (ctx: FakeCtx) =>
    dispatch(
      ctx as unknown as Parameters<typeof dispatch>[0],
      (async () => undefined) as unknown as Parameters<typeof dispatch>[1],
    );
};

const BUSINESS: Doc = { key: "business", data: { businessName: "Acme LLC" } };

const baseContract = (overrides: Doc = {}): Doc => {
  return {
    id: "ct-1",
    version: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    accountId: "default",
    clientId: "c-1",
    title: "Support Agreement",
    type: "support",
    status: "active",
    startDate: "2026-01-01",
    endDate: null,
    ...overrides,
  };
};
const cleanPdfFile = (): Doc => {
  return {
    id: "file-ct-pdf-1",
    ownerType: "contract",
    ownerId: "ct-1",
    contentType: "application/pdf",
    filename: "Support Agreement.pdf",
    objectKey: "contract/ct-1/abc",
    scanStatus: "clean",
    sizeBytes: 2048,
    createdAt: "2026-01-02T00:00:00.000Z",
    deletedAt: null,
    archivedAt: null,
  };
};
const CLIENT: Doc = { id: "c-1", displayName: "Client Co", email: "client@example.com", deletedAt: null };

const build = (store: Store) => {
  const { queue, jobs } = fakeQueue();
  const { emitter } = newEmitter();
  const router = createContractsRouter({ db: fakeDb(store), emitter, logger, queue });
  return { drive: driver(router), jobs };
};

describe("POST /api/v1/contracts/:id/send", () => {
  it("enqueues an email job attaching the contract PDF (ownerType contract)", async () => {
    const store: Store = {
      contracts: [baseContract()],
      files: [cleanPdfFile()],
      clients: [CLIENT],
      settings: [BUSINESS],
    };
    const { drive, jobs } = build(store);
    const ctx = fakeCtx({
      method: "POST",
      path: "/api/v1/contracts/ct-1/send",
      params: { id: "ct-1" },
      body: { version: 2, cc: ["cc@example.com"] },
    });
    await drive(ctx);

    expect(ctx.status).toBe(200);
    const emailJobs = jobs.filter((j) => j.name === "email");
    expect(emailJobs).toHaveLength(1);
    const payload = emailJobs[0]!.payload as EmailJob;
    expect(payload.to).toBe("client@example.com");
    expect(payload.cc).toEqual(["cc@example.com"]);
    expect(payload.attachments).toEqual([{ fileId: "file-ct-pdf-1", filename: "Support Agreement.pdf" }]);
    expect(jobs.some((j) => j.name === "pdf")).toBe(false);
  });

  it("enqueues a contract PDF render when none exists yet", async () => {
    const store: Store = {
      contracts: [baseContract()],
      files: [],
      clients: [CLIENT],
      settings: [BUSINESS],
    };
    const { drive, jobs } = build(store);
    const ctx = fakeCtx({
      method: "POST",
      path: "/api/v1/contracts/ct-1/send",
      params: { id: "ct-1" },
      body: { version: 2 },
    });
    await drive(ctx);
    expect(ctx.status).toBe(200);
    const pdfJobs = jobs.filter((j) => j.name === "pdf");
    expect(pdfJobs).toHaveLength(1);
    expect((pdfJobs[0]!.payload as { documentType: string }).documentType).toBe("contract");
    // No PDF yet → pending, no email sent (return-if-exists-else-render).
    expect(jobs.some((j) => j.name === "email")).toBe(false);
    expect((ctx.body as { data: { status: string } }).data.status).toBe("pending");
  });
});

describe("GET /api/v1/contracts/:id/send/preview", () => {
  it("returns the composed default { to, subject, html }", async () => {
    const store: Store = {
      contracts: [baseContract()],
      files: [cleanPdfFile()],
      clients: [CLIENT],
      settings: [BUSINESS],
    };
    const { drive } = build(store);
    const ctx = fakeCtx({
      method: "GET",
      path: "/api/v1/contracts/ct-1/send/preview",
      params: { id: "ct-1" },
    });
    await drive(ctx);
    expect(ctx.status).toBe(200);
    const data = (ctx.body as { data: { to: string; subject: string; html: string } }).data;
    expect(data.to).toBe("client@example.com");
    expect(data.html).toContain("Acme LLC");
  });
});
