import { describe, it, expect } from "vitest";
import type { Collection } from "mongodb";
import { createLogger, AppError } from "@billy/shared";
import type { AuthContext } from "@billy/types";
import type { DomainEventEmitter } from "@/platform/service.js";
import { ContractRepository } from "@/modules/contracts/repository.js";
import { ContractService, CONTRACT_TRANSITIONS } from "@/modules/contracts/service.js";
import { ContractCreateSchema } from "@/modules/contracts/schema.js";
import type { Contract, ContractStatus } from "@/modules/contracts/types.js";

const logger = createLogger({ level: "silent", pretty: false, service: "test" });
const emitter: DomainEventEmitter = { emit() {} };

const ctx: AuthContext = {
  userId: "507f1f77bcf86cd799439011",
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

const baseContract = (overrides: Partial<Contract> = {}): Contract => {
  const ts = new Date().toISOString();
  return {
    id: "507f191e810c19729de860ea",
    version: 1,
    createdAt: ts,
    updatedAt: ts,
    archivedAt: null,
    deletedAt: null,
    clientId: "507f1f77bcf86cd799439012",
    title: "Test contract",
    type: "development",
    status: "draft",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    valueMinor: 100000,
    currency: "EUR",
    ...overrides,
  };
};

/**
 * In-memory fake repo. Extends ContractRepository so protected members line up
 * (the base `collection`/`scopeField` are never touched by the overrides). The
 * stub Collection is typed, not `any`.
 */
class FakeContractRepository extends ContractRepository {
  private doc: Contract;

  constructor(doc: Contract) {
    super(undefined as unknown as Collection<Contract>);
    this.doc = doc;
  }

  override async findById(): Promise<Contract | null> {
    return this.doc;
  }

  override async updateVersioned(_ctx: AuthContext, _id: string, _v: number, patch: Partial<Contract>): Promise<Contract> {
    this.doc = { ...this.doc, ...patch, version: this.doc.version + 1 };
    return this.doc;
  }
}

const validCreatePayload = {
  clientId: "507f1f77bcf86cd799439012",
  title: "Website build",
  type: "development",
  startDate: "2026-01-01",
  endDate: "2026-12-31",
  valueMinor: 500000,
  currency: "EUR",
};

describe("contract schema: endDate ≥ startDate (§37)", () => {
  it("accepts endDate on or after startDate", () => {
    const r = ContractCreateSchema.safeParse(validCreatePayload);
    expect(r.success).toBe(true);
  });

  it("accepts an absent (open-ended) endDate", () => {
    const { endDate, ...rest } = validCreatePayload;
    void endDate;
    const r = ContractCreateSchema.safeParse(rest);
    expect(r.success).toBe(true);
  });

  it("rejects endDate before startDate", () => {
    const r = ContractCreateSchema.safeParse({ ...validCreatePayload, startDate: "2026-06-01", endDate: "2026-01-01" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes("endDate"))).toBe(true);
    }
  });
});

describe("contract service: guarded status transitions", () => {
  it("renewing a draft contract throws INVALID_STATE_TRANSITION", async () => {
    const repo = new FakeContractRepository(baseContract({ status: "draft" }));
    const svc = new ContractService({ repo, emitter, logger });
    const p = svc.renew(ctx, "507f191e810c19729de860ea", 1, { newStartDate: "2027-01-01", newEndDate: "2027-12-31" });
    await expect(p).rejects.toBeInstanceOf(AppError);
    await p.catch((e: unknown) => expect((e as AppError).code).toBe("INVALID_STATE_TRANSITION"));
  });

  it("renewing an active contract transitions to renewed with new dates", async () => {
    const repo = new FakeContractRepository(baseContract({ status: "active" }));
    const svc = new ContractService({ repo, emitter, logger });
    const out = await svc.renew(ctx, "507f191e810c19729de860ea", 1, { newStartDate: "2027-01-01", newEndDate: "2027-12-31" });
    expect(out.status).toBe("renewed");
    expect(out.startDate).toBe("2027-01-01");
    expect(out.endDate).toBe("2027-12-31");
  });

  it("terminal statuses allow no transitions in the map", () => {
    const terminal: ContractStatus[] = ["expired", "renewed", "terminated", "archived"];
    for (const s of terminal) {
      expect(CONTRACT_TRANSITIONS[s]).toEqual([]);
    }
  });
});
