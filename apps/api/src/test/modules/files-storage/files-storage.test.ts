import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import type { Collection } from "mongodb";
import { createLogger, AppError } from "@billy/shared";
import type { AuthContext, BaseDoc } from "@billy/types";
import type { DomainEvent, DomainEventEmitter } from "@/platform/service.js";
import type { MinioConn } from "@/infrastructure/minio.js";
import { FileObjectRepository } from "@/modules/files-storage/repository.js";
import { FileService, FILES_BUCKET } from "@/modules/files-storage/service.js";
import { RequestUploadSchema } from "@/modules/files-storage/schema.js";
import type { FileAuthorizer, FileObject, FileScanner } from "@/modules/files-storage/types.js";

// ── Test doubles ─────────────────────────────────────────────────────────────

const logger = createLogger({ level: "silent", pretty: false, service: "test" });

const newEmitter = (): { emitter: DomainEventEmitter; events: DomainEvent[] } => {
  const events: DomainEvent[] = [];
  return { emitter: { emit: (e) => void events.push(e) }, events };
};

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

/**
 * FAKE MinIO — records per-method call counts so tests can assert that NO presign
 * happened on an authorization/validation denial (the load-bearing SEC3 invariant).
 * No real MinIO involved. Cast through `unknown` to satisfy `MinioConn` without
 * reimplementing the full driver surface (no `any`).
 */
class FakeMinio {
  putCalls: Array<{ bucket: string; key: string; ttl?: number }> = [];
  getCalls: Array<{ bucket: string; key: string; ttl?: number }> = [];
  removeCalls: Array<{ bucket: string; key: string }> = [];
  /** Bytes written via the STREAMING putObject path (same-origin upload relay). */
  putObjectCalls: Array<{ bucket: string; key: string; size?: number; contentType?: string }> = [];
  /** Reads via the STREAMING getObject path (same-origin download relay). */
  getObjectCalls: Array<{ bucket: string; key: string }> = [];

  readonly client = {
    presignedPutObject: async (bucket: string, key: string, ttl?: number): Promise<string> => {
      this.putCalls.push({ bucket, key, ttl });
      return `https://minio.local/put/${bucket}/${key}?ttl=${ttl ?? 0}`;
    },
    presignedGetObject: async (bucket: string, key: string, ttl?: number): Promise<string> => {
      this.getCalls.push({ bucket, key, ttl });
      return `https://minio.local/get/${bucket}/${key}?ttl=${ttl ?? 0}`;
    },
    // Stream relay target — consume the stream so the fake behaves like the driver.
    // Mirrors the minio driver's overloads: the 4th arg is EITHER a numeric size OR
    // the metadata object (unknown-size form). The service uses the 4-arg metadata form.
    putObject: async (
      bucket: string,
      key: string,
      stream: NodeJS.ReadableStream,
      sizeOrMeta?: number | Record<string, string>,
      metaData?: Record<string, string>,
    ): Promise<{ etag: string }> => {
      const size = typeof sizeOrMeta === "number" ? sizeOrMeta : undefined;
      const meta = typeof sizeOrMeta === "object" ? sizeOrMeta : metaData;
      // Drain the stream (the real driver reads it fully) — this also surfaces the
      // byte-counting Transform's FILE_TOO_LARGE error to the awaiting caller.
      for await (const _chunk of stream) { /* discard in test */ }
      this.putObjectCalls.push({ bucket, key, size, contentType: meta?.["Content-Type"] });
      return { etag: "test-etag" };
    },
    getObject: async (bucket: string, key: string): Promise<NodeJS.ReadableStream> => {
      this.getObjectCalls.push({ bucket, key });
      return Readable.from([Buffer.from("stored-bytes")]);
    },
    removeObject: async (bucket: string, key: string): Promise<void> => {
      this.removeCalls.push({ bucket, key });
    },
  };

  async ping(): Promise<void> {
    /* reachable */
  }

  get signCallCount(): number {
    return this.putCalls.length + this.getCalls.length;
  }

  asConn(): MinioConn {
    return this as unknown as MinioConn;
  }
}

/**
 * In-memory FileObjectRepository. Extends the real class (its `collection` is
 * protected, so a structural fake cannot satisfy `BaseRepository<FileObject>`),
 * passing a dummy collection to super and overriding every used method against a Map.
 */
class FakeFileRepository extends FileObjectRepository {
  readonly byId = new Map<string, FileObject>();
  private seq = 0;

  constructor() {
    super(undefined as unknown as Collection<FileObject>);
  }

  override async findById(_ctx: AuthContext, id: string): Promise<FileObject | null> {
    const doc = this.byId.get(id);
    return doc && !doc.deletedAt ? doc : null;
  }

  override async insert(_ctx: AuthContext, data: Omit<FileObject, keyof BaseDoc>): Promise<FileObject> {
    const ts = new Date().toISOString();
    const doc = {
      ...(data as object),
      id: `f-${++this.seq}`,
      version: 1,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      deletedAt: null,
    } as FileObject;
    this.byId.set(doc.id, doc);
    return doc;
  }

  override async updateVersioned(
    _ctx: AuthContext,
    id: string,
    expectedVersion: number,
    patch: Partial<FileObject>,
  ): Promise<FileObject> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt) throw new AppError("RESOURCE_NOT_FOUND");
    if (doc.version !== expectedVersion) throw new AppError("VERSION_CONFLICT");
    const next = { ...doc, ...patch, version: doc.version + 1, updatedAt: new Date().toISOString() } as FileObject;
    this.byId.set(id, next);
    return next;
  }

  override async softDelete(_ctx: AuthContext, id: string): Promise<void> {
    const doc = this.byId.get(id);
    if (doc) this.byId.set(id, { ...doc, deletedAt: new Date().toISOString() });
  }
}

interface Harness {
  svc: FileService;
  repo: FakeFileRepository;
  minio: FakeMinio;
  events: DomainEvent[];
}

const newService = (opts: { authorizer?: FileAuthorizer; scanner?: FileScanner; maxUploadBytes?: number } = {}): Harness => {
  const repo = new FakeFileRepository();
  const minio = new FakeMinio();
  const { emitter, events } = newEmitter();
  const svc = new FileService({
    repo,
    emitter,
    logger,
    minio: minio.asConn(),
    authorizer: opts.authorizer,
    scanner: opts.scanner,
    maxUploadBytes: opts.maxUploadBytes,
  });
  return { svc, repo, minio, events };
};

const PDF_INPUT = {
  ownerType: "client",
  ownerId: "c-1",
  filename: "invoice.pdf",
  contentType: "application/pdf",
  sizeBytes: 1024,
} as const;

const denyAll: FileAuthorizer = () => {
  throw new AppError("FORBIDDEN", "denied");
};

// ── Schema: MIME allow-list + size shape ─────────────────────────────────────

describe("files-storage schema", () => {
  it("accepts a valid request-upload payload", () => {
    expect(RequestUploadSchema.safeParse(PDF_INPUT).success).toBe(true);
  });

  it("rejects a non-positive size", () => {
    expect(RequestUploadSchema.safeParse({ ...PDF_INPUT, sizeBytes: 0 }).success).toBe(false);
  });
});

// ── requestUpload: happy path + MIME reject + size reject + authorize-before-sign ─

describe("files-storage requestUpload", () => {
  it("happy path: writes a PENDING doc and mints NO presigned URL (bytes go same-origin via streamUpload)", async () => {
    const { svc, repo, minio, events } = newService();
    const result = await svc.requestUpload(ADMIN, RequestUploadSchema.parse(PDF_INPUT));

    expect(result.file.scanStatus).toBe("pending");
    expect(result.file.uploadedBy).toBe(ADMIN.userId);
    // Object key is server-generated, never the client filename (path-traversal
    // control), and namespaced by accountId (tenant partition).
    expect(result.objectKey).toMatch(/^default\/client\/c-1\/[0-9a-f-]+$/u);
    expect(result.objectKey).not.toContain("invoice.pdf");
    // No presigned upload URL is returned anymore — that URL would be signed for the
    // internal MinIO host, unreachable from a real browser. Upload is same-origin.
    expect(result).not.toHaveProperty("uploadUrl");
    expect(minio.putCalls).toHaveLength(0); // nothing presigned

    expect(repo.byId.get(result.file.id)?.scanStatus).toBe("pending");
    expect(events.map((e) => e.name)).toContain("file.upload_requested");
  });

  it("MIME reject: disallowed type → UNSUPPORTED_FILE_TYPE and NOTHING is signed", async () => {
    const { svc, minio, repo } = newService();
    await expect(
      svc.requestUpload(ADMIN, RequestUploadSchema.parse({ ...PDF_INPUT, contentType: "application/x-msdownload" })),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FILE_TYPE" });
    expect(minio.signCallCount).toBe(0);
    expect(repo.byId.size).toBe(0); // no pending doc written on rejection
  });

  it("MIME accept: SVG is allowed (branding logos/icons, operator-approved)", async () => {
    const { svc } = newService();
    const { file } = await svc.requestUpload(
      ADMIN,
      RequestUploadSchema.parse({ ...PDF_INPUT, contentType: "image/svg+xml", filename: "logo.svg" }),
    );
    expect(file.contentType).toBe("image/svg+xml");
  });

  it("size reject: oversize → FILE_TOO_LARGE and NOTHING is signed", async () => {
    const { svc, minio, repo } = newService({ maxUploadBytes: 500 });
    await expect(
      svc.requestUpload(ADMIN, RequestUploadSchema.parse({ ...PDF_INPUT, sizeBytes: 5000 })),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(minio.signCallCount).toBe(0);
    expect(repo.byId.size).toBe(0);
  });

  it("authorize-before-sign (SEC3): denial throws FORBIDDEN and presign is called ZERO times", async () => {
    const { svc, minio, repo } = newService({ authorizer: denyAll });
    await expect(svc.requestUpload(ADMIN, RequestUploadSchema.parse(PDF_INPUT))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // The load-bearing invariant: no URL minted, no pending doc, because authz precedes signing.
    expect(minio.signCallCount).toBe(0);
    expect(repo.byId.size).toBe(0);
  });
});

// ── confirmUpload: scan hook (default clean + pluggable infected) ────────────

describe("files-storage confirmUpload", () => {
  it("defaults scanStatus to clean when no scanner is configured (Q5)", async () => {
    const { svc } = newService();
    const { file } = await svc.requestUpload(ADMIN, RequestUploadSchema.parse(PDF_INPUT));
    const confirmed = await svc.confirmUpload(ADMIN, file.id, { sizeBytes: 2048 });
    expect(confirmed.scanStatus).toBe("clean");
    expect(confirmed.sizeBytes).toBe(2048);
  });

  it("records the scanner verdict when a scanner is configured (SEC4)", async () => {
    const scanner: FileScanner = { scan: async () => "infected" };
    const { svc } = newService({ scanner });
    const { file } = await svc.requestUpload(ADMIN, RequestUploadSchema.parse(PDF_INPUT));
    const confirmed = await svc.confirmUpload(ADMIN, file.id, { sizeBytes: 2048 });
    expect(confirmed.scanStatus).toBe("infected");
  });
});

// ── streamUpload: same-origin relay (no browser→MinIO), confirms in one call ──

describe("files-storage streamUpload", () => {
  it("relays bytes to MinIO via putObject and marks the file clean (no presign, no separate confirm)", async () => {
    const { svc, minio, repo, events } = newService();
    const { file } = await svc.requestUpload(ADMIN, RequestUploadSchema.parse(PDF_INPUT));
    expect(repo.byId.get(file.id)?.scanStatus).toBe("pending");

    const body = Readable.from([Buffer.from("%PDF-1.4 fake")]);
    const updated = await svc.streamUpload(ADMIN, file.id, body, { contentType: "application/pdf", sizeBytes: 13 });

    // Bytes went through the API to MinIO (putObject), NOT a presigned browser PUT.
    expect(minio.putObjectCalls).toHaveLength(1);
    expect(minio.putObjectCalls[0]!.bucket).toBe(FILES_BUCKET);
    expect(minio.putObjectCalls[0]!.key).toBe(file.objectKey);
    expect(minio.putCalls).toHaveLength(0); // no presigned URLs anywhere in the flow
    // Confirmed + scanned in the same call → clean, downloadable now.
    expect(updated.scanStatus).toBe("clean");
    expect(updated.sizeBytes).toBe(13);
    expect(repo.byId.get(file.id)?.scanStatus).toBe("clean");
    expect(events.map((e) => e.name)).toContain("file.confirmed");
  });

  it("records the scanner verdict (infected file stays non-downloadable)", async () => {
    const scanner: FileScanner = { scan: async () => "infected" };
    const { svc } = newService({ scanner });
    const { file } = await svc.requestUpload(ADMIN, RequestUploadSchema.parse(PDF_INPUT));
    const updated = await svc.streamUpload(ADMIN, file.id, Readable.from([Buffer.from("x")]), {
      contentType: "application/pdf",
      sizeBytes: 1,
    });
    expect(updated.scanStatus).toBe("infected");
  });

  it("authorize-before-write: denial → FORBIDDEN and putObject called ZERO times", async () => {
    // Allow the requestUpload (to create the pending doc), then deny the stream write.
    let phase: "setup" | "guard" = "setup";
    const authorizer: FileAuthorizer = () => {
      if (phase === "guard") throw new AppError("FORBIDDEN");
    };
    const { svc, minio } = newService({ authorizer });
    const { file } = await svc.requestUpload(ADMIN, RequestUploadSchema.parse(PDF_INPUT));
    phase = "guard";
    await expect(
      svc.streamUpload(ADMIN, file.id, Readable.from([Buffer.from("x")]), { contentType: "application/pdf", sizeBytes: 1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(minio.putObjectCalls).toHaveLength(0);
  });

  it("rejects a disallowed MIME before writing anything", async () => {
    const { svc, minio } = newService();
    const { file } = await svc.requestUpload(ADMIN, RequestUploadSchema.parse(PDF_INPUT));
    await expect(
      svc.streamUpload(ADMIN, file.id, Readable.from([Buffer.from("x")]), { contentType: "application/x-msdownload", sizeBytes: 1 }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FILE_TYPE" });
    expect(minio.putObjectCalls).toHaveLength(0);
  });

  it("missing pending doc → RESOURCE_NOT_FOUND", async () => {
    const { svc } = newService();
    await expect(
      svc.streamUpload(ADMIN, "nope", Readable.from([Buffer.from("x")]), { contentType: "application/pdf", sizeBytes: 1 }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("enforces the size cap on the STREAM even with NO declared size (chunked-upload OOM guard)", async () => {
    // No sizeBytes (mimics chunked upload with no Content-Length): the header guard is
    // skipped, so the byte-counting Transform must bound it. Stream 1200 bytes past a
    // 1000-byte cap → FILE_TOO_LARGE, and the file must NOT be marked clean.
    const { svc, repo } = newService({ maxUploadBytes: 1000 });
    // Declared size passes the request-upload guard (a lying/absent Content-Length is
    // the whole point); the stream then delivers 1200 bytes, exceeding the cap.
    const { file } = await svc.requestUpload(ADMIN, RequestUploadSchema.parse({ ...PDF_INPUT, sizeBytes: 100 }));
    const oversize = Readable.from([Buffer.alloc(600, 1), Buffer.alloc(600, 2)]);
    await expect(
      svc.streamUpload(ADMIN, file.id, oversize, { contentType: "application/pdf" /* no sizeBytes */ }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    // Fails safe: stays pending, never downloadable.
    expect(repo.byId.get(file.id)?.scanStatus).toBe("pending");
  });
});

// ── streamDownload: authorize + scan gating (same-origin `/content`, no presign) ─
// NOTE: the presigned `/download-url` route + requestDownload were removed — a
// presigned URL is signed for MinIO's internal host, unreachable from a real
// browser. All transfer is same-origin via streamDownload / streamUpload.

describe("files-storage streamDownload", () => {
  it("authorized + clean → returns the object stream (no presign)", async () => {
    const { svc, minio } = newService();
    const { file } = await svc.requestUpload(ADMIN, RequestUploadSchema.parse(PDF_INPUT));
    await svc.streamUpload(ADMIN, file.id, Readable.from([Buffer.from("x")]), { contentType: "application/pdf", sizeBytes: 1 }); // → clean
    const { stream } = await svc.streamDownload(ADMIN, file.id);
    expect(stream).toBeDefined();
    expect(minio.getObjectCalls).toHaveLength(1);
    expect(minio.getCalls).toHaveLength(0); // never presigned a GET
  });

  it("authorize-before-read: download denial → FORBIDDEN and getObject called ZERO times", async () => {
    const authorizer: FileAuthorizer = (_ctx, _owner, action) => {
      if (action === "download") throw new AppError("FORBIDDEN");
    };
    const { svc, minio } = newService({ authorizer });
    const { file } = await svc.requestUpload(ADMIN, RequestUploadSchema.parse(PDF_INPUT));
    await svc.streamUpload(ADMIN, file.id, Readable.from([Buffer.from("x")]), { contentType: "application/pdf", sizeBytes: 1 });
    await expect(svc.streamDownload(ADMIN, file.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(minio.getObjectCalls).toHaveLength(0);
  });

  it("scan gating: a pending file is NOT served → FORBIDDEN, getObject called zero times", async () => {
    const { svc, minio } = newService();
    const { file } = await svc.requestUpload(ADMIN, RequestUploadSchema.parse(PDF_INPUT));
    // not uploaded/confirmed → still pending
    await expect(svc.streamDownload(ADMIN, file.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(minio.getObjectCalls).toHaveLength(0);
  });

  it("missing file → RESOURCE_NOT_FOUND", async () => {
    const { svc } = newService();
    await expect(svc.streamDownload(ADMIN, "nope")).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
});

// ── delete: removeObject then soft-delete ────────────────────────────────────

describe("files-storage delete", () => {
  it("removes the object then soft-deletes the metadata doc", async () => {
    const { svc, repo, minio, events } = newService();
    const { file } = await svc.requestUpload(ADMIN, RequestUploadSchema.parse(PDF_INPUT));
    await svc.delete(ADMIN, file.id);
    expect(minio.removeCalls).toHaveLength(1);
    expect(minio.removeCalls[0]!.key).toBe(file.objectKey);
    expect(repo.byId.get(file.id)?.deletedAt).toBeTruthy();
    expect(events.map((e) => e.name)).toContain("file.deleted");
  });
});
