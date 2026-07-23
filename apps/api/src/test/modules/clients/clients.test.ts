import { describe, it, expect } from "vitest";
import type { Collection } from "mongodb";
import { createLogger, AppError } from "@billy/shared";
import type { AuthContext } from "@billy/types";
import type { DomainEvent, DomainEventEmitter } from "@/platform/service.js";
import { ClientRepository } from "@/modules/clients/repository.js";
import { ClientService } from "@/modules/clients/service.js";
import { ClientCreateSchema, ClientUpdateSchema } from "@/modules/clients/schema.js";
import type { Client } from "@/modules/clients/types.js";

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

const MEMBER: AuthContext = {
  userId: "u-member",
  role: "member",
  capabilities: {
    canManageSettings: false,
    canManageUsers: false,
    canPermanentlyDelete: false,
    canViewFinancialTotals: false,
    canExportData: false,
  },
  accountId: "default",
};

/**
 * In-memory ClientRepository. Extends the real class (its `collection`/`scopeField`
 * are protected, so a plain structural fake cannot satisfy `BaseRepository<Client>`),
 * passing a dummy collection to super and overriding every public method against a Map.
 */
class FakeClientRepository extends ClientRepository {
  readonly byId = new Map<string, Client>();
  private seq = 0;

  constructor() {
    super(undefined as unknown as Collection<Client>);
  }

  override async findById(_ctx: AuthContext, id: string): Promise<Client | null> {
    const doc = this.byId.get(id);
    return doc && !doc.deletedAt ? doc : null;
  }

  override async insert(_ctx: AuthContext, data: Omit<Client, keyof import("@billy/types").BaseDoc>): Promise<Client> {
    const ts = new Date().toISOString();
    const doc = {
      ...(data as object),
      id: `c-${++this.seq}`,
      version: 1,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      deletedAt: null,
    } as Client;
    this.byId.set(doc.id, doc);
    return doc;
  }

  override async updateVersioned(
    _ctx: AuthContext,
    id: string,
    expectedVersion: number,
    patch: Partial<Client>,
  ): Promise<Client> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt) throw notFound();
    if (doc.archivedAt) throw notFound(); // base updateVersioned only matches non-archived
    if (doc.version !== expectedVersion) throw versionConflict();
    const next = { ...doc, ...patch, version: doc.version + 1, updatedAt: new Date().toISOString() } as Client;
    this.byId.set(id, next);
    return next;
  }

  override async archive(_ctx: AuthContext, id: string, expectedVersion: number): Promise<Client> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt) throw notFound();
    if (doc.version !== expectedVersion) throw versionConflict();
    const next = { ...doc, archivedAt: new Date().toISOString(), version: doc.version + 1 } as Client;
    this.byId.set(id, next);
    return next;
  }

  override async restore(_ctx: AuthContext, id: string, expectedVersion: number): Promise<Client> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt || !doc.archivedAt) throw notFound();
    if (doc.version !== expectedVersion) throw versionConflict();
    const next = { ...doc, archivedAt: null, version: doc.version + 1 } as Client;
    this.byId.set(id, next);
    return next;
  }

  override async softDelete(_ctx: AuthContext, id: string): Promise<void> {
    const doc = this.byId.get(id);
    if (doc) this.byId.set(id, { ...doc, deletedAt: new Date().toISOString() });
  }
}

const notFound = () => {
  return new AppError("RESOURCE_NOT_FOUND");
};
const versionConflict = () => {
  return new AppError("VERSION_CONFLICT");
};

const newService = () => {
  const repo = new FakeClientRepository();
  const { emitter, events } = newEmitter();
  const svc = new ClientService({ repo, emitter, logger });
  return { repo, svc, events };
};

const COMPANY_INPUT = { type: "company", displayName: "Acme SpA", legalName: "Acme S.p.A." } as const;
const INDIVIDUAL_INPUT = { type: "individual", displayName: "Jane Roe", firstName: "Jane", lastName: "Roe" } as const;

// ── Schema: company vs individual conditional validation ─────────────────────

describe("client schema — company vs individual conditional required fields", () => {
  it("accepts a valid company (legalName present)", () => {
    const r = ClientCreateSchema.safeParse(COMPANY_INPUT);
    expect(r.success).toBe(true);
  });

  it("rejects a company missing legalName", () => {
    const r = ClientCreateSchema.safeParse({ type: "company", displayName: "Acme" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.join(".") === "legalName")).toBe(true);
  });

  it("accepts a valid individual (first + last name present)", () => {
    const r = ClientCreateSchema.safeParse(INDIVIDUAL_INPUT);
    expect(r.success).toBe(true);
  });

  it("rejects an individual missing lastName", () => {
    const r = ClientCreateSchema.safeParse({ type: "individual", displayName: "Jane", firstName: "Jane" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.join(".") === "lastName")).toBe(true);
  });

  it("validates the embedded billingAddress (@billy/validation Address)", () => {
    const ok = ClientCreateSchema.safeParse({
      ...COMPANY_INPUT,
      billingAddress: { line1: "1 Main St", city: "Rome", postalCode: "00100", country: "IT" },
    });
    expect(ok.success).toBe(true);
    const bad = ClientCreateSchema.safeParse({
      ...COMPANY_INPUT,
      billingAddress: { line1: "1 Main St", city: "Rome", postalCode: "00100", country: "ITALY" },
    });
    expect(bad.success).toBe(false);
  });

  it("normalizes email to lowercase and defaults tags to []", () => {
    const r = ClientCreateSchema.parse({ ...COMPANY_INPUT, email: "SALES@ACME.IO" });
    expect(r.email).toBe("sales@acme.io");
    expect(r.tags).toEqual([]);
  });

  it("update schema still enforces the type rule when type is supplied", () => {
    const bad = ClientUpdateSchema.safeParse({ type: "individual", firstName: "Jane" });
    expect(bad.success).toBe(false);
    const partialOk = ClientUpdateSchema.safeParse({ phone: "+39 06 1234" });
    expect(partialOk.success).toBe(true);
  });
});

// ── Service: create / update-version-conflict / archive / restore / delete ───

describe("client service", () => {
  it("create persists and emits client.created", async () => {
    const { svc, events } = newService();
    const created = await svc.create(ADMIN, ClientCreateSchema.parse(COMPANY_INPUT));
    expect(created.id).toBeTruthy();
    expect(created.version).toBe(1);
    expect(created.type).toBe("company");
    expect(created.tags).toEqual([]);
    expect(events.map((e) => e.name)).toContain("client.created");
  });

  it("get returns the created client; missing id → RESOURCE_NOT_FOUND", async () => {
    const { svc } = newService();
    const created = await svc.create(ADMIN, ClientCreateSchema.parse(INDIVIDUAL_INPUT));
    expect((await svc.get(ADMIN, created.id)).id).toBe(created.id);
    await expect(svc.get(ADMIN, "nope")).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("update with the correct version succeeds and bumps version + emits client.updated", async () => {
    const { svc, events } = newService();
    const created = await svc.create(ADMIN, ClientCreateSchema.parse(COMPANY_INPUT));
    const updated = await svc.update(ADMIN, created.id, created.version, { phone: "+39 06 999" });
    expect(updated.version).toBe(2);
    expect(updated.phone).toBe("+39 06 999");
    expect(events.map((e) => e.name)).toContain("client.updated");
  });

  it("update with a stale version → VERSION_CONFLICT", async () => {
    const { svc } = newService();
    const created = await svc.create(ADMIN, ClientCreateSchema.parse(COMPANY_INPUT));
    await svc.update(ADMIN, created.id, created.version, { phone: "a" });
    await expect(svc.update(ADMIN, created.id, created.version, { phone: "b" })).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
  });

  it("never lets a body `version` leak into the persisted patch", async () => {
    const { svc, repo } = newService();
    const created = await svc.create(ADMIN, ClientCreateSchema.parse(COMPANY_INPUT));
    await svc.update(ADMIN, created.id, created.version, { version: 999, phone: "x" });
    expect(repo.byId.get(created.id)!.version).toBe(2); // incremented once, not set to 999
  });

  it("archive sets archivedAt and emits client.archived; restore clears it", async () => {
    const { svc, repo, events } = newService();
    const created = await svc.create(ADMIN, ClientCreateSchema.parse(COMPANY_INPUT));
    const archived = await svc.archive(ADMIN, created.id, created.version);
    expect(archived.archivedAt).toBeTruthy();
    expect(events.map((e) => e.name)).toContain("client.archived");

    const restored = await svc.restore(ADMIN, archived.id, archived.version);
    expect(restored.archivedAt).toBeNull();
    expect(repo.byId.get(created.id)!.archivedAt).toBeNull();
  });

  it("update on an archived client → RESOURCE_NOT_FOUND (base filter excludes archived)", async () => {
    const { svc } = newService();
    const created = await svc.create(ADMIN, ClientCreateSchema.parse(COMPANY_INPUT));
    const archived = await svc.archive(ADMIN, created.id, created.version);
    await expect(svc.update(ADMIN, created.id, archived.version, { phone: "y" })).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
  });

  it("softDelete requires canPermanentlyDelete", async () => {
    const { svc } = newService();
    const created = await svc.create(ADMIN, ClientCreateSchema.parse(COMPANY_INPUT));
    await expect(svc.softDelete(MEMBER, created.id)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    await expect(svc.softDelete(ADMIN, created.id)).resolves.toBeUndefined();
    await expect(svc.get(ADMIN, created.id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  // ── GDPR Art. 17 erasure-as-anonymization (gdpr-privacy_plan GDPR-2) ─────────
  it("anonymize requires canPermanentlyDelete", async () => {
    const { svc } = newService();
    const created = await svc.create(
      ADMIN,
      ClientCreateSchema.parse({ ...INDIVIDUAL_INPUT, email: "jane@roe.example", phone: "+39 000" }),
    );
    await expect(svc.anonymize(MEMBER, created.id)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
  });

  it("anonymize pseudonymizes PII in place but keeps the (non-deleted) record", async () => {
    const { svc, events } = newService();
    const created = await svc.create(
      ADMIN,
      ClientCreateSchema.parse({
        ...INDIVIDUAL_INPUT,
        email: "jane@roe.example",
        phone: "+39 000",
        vatNumber: "IT12345",
        notes: "VIP",
      }),
    );
    const erased = await svc.anonymize(ADMIN, created.id);

    // PII scrubbed…
    expect(erased.email).toBeNull();
    expect(erased.phone).toBeNull();
    expect(erased.vatNumber).toBeNull();
    expect(erased.firstName).toBeNull();
    expect(erased.lastName).toBeNull();
    expect(erased.notes).toBeNull();
    expect(erased.tags).toEqual([]);
    // …display name replaced with a stable, non-identifying pseudonym…
    expect(erased.displayName).toBe(`[erased-${created.id}]`);
    // …the record itself is retained (NOT soft-deleted) so financial docs stay valid.
    expect(erased.deletedAt ?? null).toBeNull();
    await expect(svc.get(ADMIN, created.id)).resolves.toMatchObject({ id: created.id });
    // …and the erasure is audited.
    expect(events.some((e) => e.name === "client.updated" && (e.payload as { anonymized?: boolean })?.anonymized)).toBe(
      true,
    );
  });
});
