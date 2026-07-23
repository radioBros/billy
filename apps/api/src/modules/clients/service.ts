import type { AuthContext, ListMeta } from "@billy/types";
import { errors } from "@billy/shared";
import { BaseService, type ServiceDeps } from "@/platform/service.js";
import type { ClientRepository } from "@/modules/clients/repository.js";
import { CLIENT_LIST_WHITELIST, type ClientCreateInput, type ClientUpdateInput } from "@/modules/clients/schema.js";
import type { Client } from "@/modules/clients/types.js";

/**
 * Client business logic. All logic lives here, never in the controllers. Owns:
 * create/get/update (optimistic concurrency), list, archive/restore, soft-delete
 * (capability-gated), and `client.*` domain events. Every repository call threads
 * the mandatory `authContext`.
 *
 * Client carries NO monetary fields, so there is no server-side money recompute
 * and no financial-field stripping here — those belong to the summary endpoint
 * (out of scope).
 */
export interface ClientServiceDeps extends ServiceDeps<Client> {
  repo: ClientRepository;
}

export class ClientService extends BaseService<Client> {
  protected override readonly repo: ClientRepository;

  constructor(deps: ClientServiceDeps) {
    super(deps);
    this.repo = deps.repo;
  }

  async create(ctx: AuthContext, input: ClientCreateInput): Promise<Client> {
    // Schema (superRefine) already enforced the company/individual conditional
    // fields; the repository stamps BaseDoc (id/version/timestamps).
    const created = await this.repo.insert(ctx, {
      ...input,
      tags: input.tags ?? [],
    } as Omit<Client, "id" | "version" | "createdAt" | "updatedAt" | "archivedAt" | "deletedAt">);
    await this.emit({
      name: "client.created",
      actorId: ctx.userId,
      entityType: "client",
      entityId: created.id,
      payload: { type: created.type },
    });
    return created;
  }

  async get(ctx: AuthContext, id: string): Promise<Client> {
    const doc = await this.repo.findById(ctx, id);
    if (!doc) throw errors.notFound();
    return doc;
  }

  async list(
    ctx: AuthContext,
    rawQuery: Record<string, string | string[] | undefined>,
  ): Promise<{ items: Client[]; meta: ListMeta }> {
    const { items, parsed, total } = await this.repo.list(ctx, rawQuery, CLIENT_LIST_WHITELIST);
    const meta: ListMeta = {
      page: parsed.page,
      limit: parsed.limit,
      total,
      pageCount: Math.max(1, Math.ceil(total / parsed.limit)),
      sort: parsed.sortSpec,
      ...(parsed.q ? { q: parsed.q } : {}),
    };
    return { items, meta };
  }

  /** Versioned update — `expectedVersion` from If-Match/body. */
  async update(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    input: ClientUpdateInput,
  ): Promise<Client> {
    // Never let a client-sent `version` land in the patch — it's the guard, not data.
    const { version: _ignored, ...patch } = input;
    void _ignored;
    const updated = await this.repo.updateVersioned(ctx, id, expectedVersion, patch as Partial<Client>);
    await this.emit({
      name: "client.updated",
      actorId: ctx.userId,
      entityType: "client",
      entityId: updated.id,
    });
    return updated;
  }

  async archive(ctx: AuthContext, id: string, expectedVersion: number): Promise<Client> {
    const archived = await this.repo.archive(ctx, id, expectedVersion);
    await this.emit({
      name: "client.archived",
      actorId: ctx.userId,
      entityType: "client",
      entityId: archived.id,
    });
    return archived;
  }

  async restore(ctx: AuthContext, id: string, expectedVersion: number): Promise<Client> {
    const restored = await this.repo.restore(ctx, id, expectedVersion);
    await this.emit({
      name: "client.updated",
      actorId: ctx.userId,
      entityType: "client",
      entityId: restored.id,
      payload: { restored: true },
    });
    return restored;
  }

  /** Soft-delete (DELETE /:id → `deletedAt`). Gated by `canPermanentlyDelete`. */
  async softDelete(ctx: AuthContext, id: string): Promise<void> {
    this.requireCapability(ctx, "canPermanentlyDelete");
    const existing = await this.repo.findById(ctx, id);
    if (!existing) throw errors.notFound();
    await this.repo.softDelete(ctx, id);
    await this.emit({
      name: "client.updated",
      actorId: ctx.userId,
      entityType: "client",
      entityId: id,
      payload: { deleted: true },
    });
  }

  /**
   * GDPR right-to-erasure via **anonymization** (Art. 17). Financial documents
   * referencing this client (finalized invoices, payments, credit notes) carry
   * legally-required tax-retention data and MUST NOT be hard-deleted (retention
   * requirements + finalized-invoice immutability). So instead of deleting the
   * client we **pseudonymize every personal identifier
   * in place** — name, email, phone, tax ids, addresses, notes — leaving a
   * non-identifying shell so the financial records remain valid without
   * identifying the data subject. The action is capability-gated + audited.
   *
   * NOTE: the immutable `clientSnapshot` embedded on already-finalized invoices
   * is intentionally preserved (it is the legal record at time of issue); this
   * anonymizes the live Client. Snapshot scrubbing on non-finalized docs is a
   * follow-up.
   */
  async anonymize(ctx: AuthContext, id: string): Promise<Client> {
    this.requireCapability(ctx, "canPermanentlyDelete");
    const existing = await this.repo.findById(ctx, id);
    if (!existing) throw errors.notFound();

    // Stable, non-reversible pseudonym derived from the id (so references stay
    // linkable for integrity/audit without carrying personal data).
    const pseudonym = `[erased-${id}]`;
    const scrub: Partial<Client> = {
      displayName: pseudonym,
      legalName: null,
      firstName: null,
      lastName: null,
      email: null,
      phone: null,
      website: null,
      vatNumber: null,
      taxCode: null,
      recipientCode: null,
      pecEmail: null,
      billingAddress: null,
      shippingAddress: null,
      notes: null,
      tags: [],
    };
    // Use the current version for the optimistic-concurrency guard (erasure is
    // an admin action, not a user edit racing another writer).
    const updated = await this.repo.updateVersioned(ctx, id, existing.version, scrub);
    await this.emit({
      name: "client.updated",
      actorId: ctx.userId,
      entityType: "client",
      entityId: id,
      // Audited as a rights-response.
      payload: { anonymized: true, reason: "gdpr-erasure" },
    });
    return updated;
  }
}
