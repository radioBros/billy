import type { AuthContext, ListMeta } from "@billy/types";
import { errors } from "@billy/shared";
import { BaseService, type ServiceDeps, assertTransition } from "@/platform/service.js";
import { CONTRACT_LIST_WHITELIST } from "@/modules/contracts/schema.js";
import type { ContractCreateInput, ContractRenewInput, ContractUpdateInput } from "@/modules/contracts/schema.js";
import type { Contract, ContractStatus } from "@/modules/contracts/types.js";
import type { ContractRepository } from "@/modules/contracts/repository.js";

/**
 * Contract business logic. All logic lives here, never in the
 * controllers: capability checks, guarded status transitions,
 * and `contract.*` domain events. Every repository
 * call threads the mandatory `authContext`.
 *
 * Money field is `valueMinor` (integer minor units); the service never trusts a
 * client-recomputed total — the schema only proves shape.
 */

/**
 * Allowed status transitions
 * (`draft → active → expiring(derived) → expired|renewed|terminated`).
 * `expiring`/`expired` are scanner-derived — legal targets FROM active/expiring,
 * but this module builds no route that user-sets them; the map exists to guard
 * the renew action. `expired`/`renewed`/`terminated`/`archived` are terminal.
 */
export const CONTRACT_TRANSITIONS: Partial<Record<ContractStatus, readonly ContractStatus[]>> = {
  draft: ["active"],
  active: ["expiring", "expired", "renewed", "terminated"],
  expiring: ["expired", "renewed", "terminated"],
  expired: [],
  renewed: [],
  terminated: [],
  archived: [],
};

export interface ContractServiceDeps extends ServiceDeps<Contract> {
  repo: ContractRepository;
}

export class ContractService extends BaseService<Contract> {
  protected override readonly repo: ContractRepository;

  constructor(deps: ContractServiceDeps) {
    super(deps);
    this.repo = deps.repo;
  }

  async create(ctx: AuthContext, input: ContractCreateInput): Promise<Contract> {
    // Status is server-owned — a new contract is always `draft`; lifecycle moves
    // go through the guarded actions. Related entities are string ids only.
    const created = await this.repo.insert(ctx, {
      clientId: input.clientId,
      projectId: input.projectId ?? null,
      title: input.title,
      type: input.type,
      status: "draft",
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      valueMinor: input.valueMinor ?? null,
      currency: input.currency ?? null,
      relatedRecurringProfileId: input.relatedRecurringProfileId ?? null,
      fileId: input.fileId ?? null,
      terms: input.terms ?? null,
      notes: input.notes ?? null,
      createdBy: ctx.userId,
    } as Omit<Contract, "id" | "version" | "createdAt" | "updatedAt" | "archivedAt" | "deletedAt">);
    await this.emit({
      name: "contract.created",
      actorId: ctx.userId,
      entityType: "contract",
      entityId: created.id,
      payload: { type: created.type },
    });
    return created;
  }

  async get(ctx: AuthContext, id: string): Promise<Contract> {
    const doc = await this.repo.findById(ctx, id);
    if (!doc) throw errors.notFound();
    return doc;
  }

  async list(
    ctx: AuthContext,
    rawQuery: Record<string, string | string[] | undefined>,
  ): Promise<{ items: Contract[]; meta: ListMeta }> {
    const { items, parsed, total } = await this.repo.list(ctx, rawQuery, CONTRACT_LIST_WHITELIST);
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
    input: ContractUpdateInput,
  ): Promise<Contract> {
    // Never let a client-sent `version` land in the patch — it's the guard, not data.
    const { version: _ignored, ...patch } = input;
    void _ignored;
    const updated = await this.repo.updateVersioned(ctx, id, expectedVersion, patch as Partial<Contract>);
    await this.emit({
      name: "contract.updated",
      actorId: ctx.userId,
      entityType: "contract",
      entityId: updated.id,
    });
    return updated;
  }

  async archive(ctx: AuthContext, id: string, expectedVersion: number): Promise<Contract> {
    const archived = await this.repo.archive(ctx, id, expectedVersion);
    await this.emit({
      name: "contract.archived",
      actorId: ctx.userId,
      entityType: "contract",
      entityId: archived.id,
    });
    return archived;
  }

  async restore(ctx: AuthContext, id: string, expectedVersion: number): Promise<Contract> {
    const restored = await this.repo.restore(ctx, id, expectedVersion);
    await this.emit({
      name: "contract.updated",
      actorId: ctx.userId,
      entityType: "contract",
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
      name: "contract.updated",
      actorId: ctx.userId,
      entityType: "contract",
      entityId: id,
      payload: { deleted: true },
    });
  }

  /**
   * Renew. Reads current status from the DOC, guards the
   * `→ renewed` transition (illegal → INVALID_STATE_TRANSITION), then applies the
   * new term dates. Linked-profile effect is stubbed until recurring-billing
   * exposes the reciprocal API.
   */
  async renew(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    input: ContractRenewInput,
  ): Promise<Contract> {
    const current = await this.repo.findById(ctx, id);
    if (!current) throw errors.notFound();

    assertTransition<ContractStatus>(current.status, "renewed", CONTRACT_TRANSITIONS);

    const updated = await this.repo.updateVersioned(ctx, id, expectedVersion, {
      status: "renewed",
      startDate: input.newStartDate,
      endDate: input.newEndDate ?? null,
    } as Partial<Contract>);
    await this.emit({
      name: "contract.renewed",
      actorId: ctx.userId,
      entityType: "contract",
      entityId: updated.id,
      payload: { newStartDate: input.newStartDate, newEndDate: input.newEndDate ?? null },
    });
    return updated;
  }
}
