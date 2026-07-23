import { describe, it, expect } from "vitest";
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

  readonly client = {
    presignedPutObject: async (bucket: string, key: string, ttl?: number): Promise<string> => {
      this.putCalls.push({ bucket, key, ttl });
      return `https://minio.local/put/${bucket}/${key}?ttl=${ttl ?? 0}`;
    },
    presignedGetObject: async (bucket: string, key: string, ttl?: number): Promise<string> => {
      this.getCalls.push({ bucket, key, ttl });
      return `https://minio.local/get/${bucket}/${key}?ttl=${ttl ?? 0}`;
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
  it("happy path: writes a PENDING doc and presigns a PUT with the short TTL", async () => {
    const { svc, repo, minio, events } = newService();
    const result = await svc.requestUpload(ADMIN, RequestUploadSchema.parse(PDF_INPUT));

    expect(result.file.scanStatus).toBe("pending");
    expect(result.file.uploadedBy).toBe(ADMIN.userId);
    // Object key is server-generated, never the client filename (path-traversal
    // control), and namespaced by accountId (tenant partition).
    expect(result.objectKey).toMatch(/^default\/client\/c-1\/[0-9a-f-]+$/u);
    expect(result.objectKey).not.toContain("invoice.pdf");
    expect(result.uploadUrl).toContain("/put/");

    expect(repo.byId.get(result.file.id)?.scanStatus).toBe("pending");
    expect(minio.putCalls).toHaveLength(1);
    expect(minio.putCalls[0]!.bucket).toBe(FILES_BUCKET);
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

// ── requestDownload: authorize-before-sign + scan gating (SEC3/SEC4) ─────────

describe("files-storage requestDownload", () => {
  it("authorized + clean → short-TTL presigned GET", async () => {
    const { svc, minio } = newService();
    const { file } = await svc.requestUpload(ADMIN, RequestUploadSchema.parse(PDF_INPUT));
    await svc.confirmUpload(ADMIN, file.id, { sizeBytes: 2048 }); // → clean
    const { downloadUrl } = await svc.requestDownload(ADMIN, file.id);
    expect(downloadUrl).toContain("/get/");
    expect(minio.getCalls).toHaveLength(1);
    expect(minio.getCalls[0]!.ttl).toBe(300);
  });

  it("authorize-before-sign (SEC3): denial → FORBIDDEN and GET presign called ZERO times", async () => {
    // Authorize allows the upload/confirm, then a denying authorizer blocks download.
    let allowUpload = true;
    const authorizer: FileAuthorizer = (_ctx, _owner, action) => {
      if (action === "download" || !allowUpload) throw new AppError("FORBIDDEN");
    };
    const { svc, minio } = newService({ authorizer });
    const { file } = await svc.requestUpload(ADMIN, RequestUploadSchema.parse(PDF_INPUT));
    await svc.confirmUpload(ADMIN, file.id, { sizeBytes: 2048 });
    allowUpload = true;
    await expect(svc.requestDownload(ADMIN, file.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(minio.getCalls).toHaveLength(0);
  });

  it("scan gating (SEC4/SU7): a pending file is NOT signable → FORBIDDEN, GET called zero times", async () => {
    const { svc, minio } = newService();
    const { file } = await svc.requestUpload(ADMIN, RequestUploadSchema.parse(PDF_INPUT));
    // not confirmed → still pending
    await expect(svc.requestDownload(ADMIN, file.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(minio.getCalls).toHaveLength(0);
  });

  it("missing file → RESOURCE_NOT_FOUND", async () => {
    const { svc } = newService();
    await expect(svc.requestDownload(ADMIN, "nope")).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
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
