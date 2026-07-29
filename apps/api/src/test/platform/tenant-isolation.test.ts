import { describe, it, expect } from "vitest";
import type { AuthContext, BaseDoc } from "@billy/types";
import { BaseRepository } from "@/platform/repository.js";

/**
 * CROSS-TENANT ISOLATION — the security green light for the multi-account refactor.
 *
 * Creates two accounts, writes data as each, and asserts that account A can NEVER
 * read/update/delete account B's rows through the fail-closed BaseRepository. This
 * exercises the REAL repository against a fake collection whose `matches()`
 * honors the accountId filter, so a missing/incorrect scope filter makes the test
 * go red (proven: temporarily removing the accountId from BaseRepository.scopedFilter
 * turns these assertions red).
 *
 * Bypass sites (dashboard aggregation, settings singletons, numbering, export,
 * pdf/preview, public-links, files) are covered by their own module tests seeded
 * per-account; this test locks down the shared repository contract every domain
 * entity inherits.
 */

interface Doc extends BaseDoc {
  [k: string]: unknown;
}

/** In-memory collection that honors equality + soft-delete/archive filters. */
const fakeCollection = () => {
  const store: Doc[] = [];
  const matches = (doc: Doc, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([key, cond]) => {
      const val = (doc as Record<string, unknown>)[key];
      if (cond !== null && typeof cond === "object") {
        const c = cond as Record<string, unknown>;
        if ("$ne" in c) return val !== c.$ne;
        if ("$in" in c) return (c.$in as unknown[]).includes(val);
        return false;
      }
      return val === cond;
    });
  return {
    store,
    async insertOne(doc: Doc): Promise<void> {
      store.push({ ...doc });
    },
    async findOne(filter: Record<string, unknown> = {}): Promise<Doc | null> {
      return store.find((d) => matches(d, filter)) ?? null;
    },
    find(filter: Record<string, unknown> = {}) {
      let rows = store.filter((d) => matches(d, filter));
      const cursor = {
        sort() {
          return cursor;
        },
        skip(n: number) {
          rows = rows.slice(n);
          return cursor;
        },
        limit(n: number) {
          rows = rows.slice(0, n);
          return cursor;
        },
        async toArray(): Promise<Doc[]> {
          return rows.map((r) => ({ ...r }));
        },
      };
      return cursor;
    },
    async countDocuments(filter: Record<string, unknown> = {}): Promise<number> {
      return store.filter((d) => matches(d, filter)).length;
    },
    async findOneAndUpdate(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ): Promise<Doc | null> {
      const doc = store.find((d) => matches(d, filter));
      if (!doc) return null;
      const set = (update.$set ?? {}) as Record<string, unknown>;
      const inc = (update.$inc ?? {}) as Record<string, number>;
      Object.assign(doc, set);
      for (const [k, v] of Object.entries(inc)) {
        (doc as Record<string, number>)[k] = ((doc as Record<string, number>)[k] ?? 0) + v;
      }
      return { ...doc };
    },
    async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<void> {
      const doc = store.find((d) => matches(d, filter));
      if (!doc) return;
      Object.assign(doc, (update.$set ?? {}) as Record<string, unknown>);
    },
  };
};

const ctxFor = (accountId: string): AuthContext => ({
  userId: `u-${accountId}`,
  role: "administrator",
  capabilities: {
    canManageSettings: true,
    canManageUsers: true,
    canPermanentlyDelete: true,
    canViewFinancialTotals: true,
    canExportData: true,
  },
  accountId,
});

const A = ctxFor("acct-A");
const B = ctxFor("acct-B");

describe("cross-tenant isolation (BaseRepository fail-closed)", () => {
  const makeRepo = () => {
    const col = fakeCollection();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new BaseRepository<Doc>(col as any);
    return { col, repo };
  };

  it("list() never returns another account's rows", async () => {
    const { repo } = makeRepo();
    await repo.insert(A, { name: "a1" } as Omit<Doc, keyof BaseDoc>);
    await repo.insert(A, { name: "a2" } as Omit<Doc, keyof BaseDoc>);
    await repo.insert(B, { name: "b1" } as Omit<Doc, keyof BaseDoc>);

    const whitelist = { sortable: ["createdAt"], filterable: [], searchable: [] };
    const listA = await repo.list(A, {}, whitelist);
    const listB = await repo.list(B, {}, whitelist);

    expect(listA.total).toBe(2);
    expect(listA.items.every((d) => d.accountId === "acct-A")).toBe(true);
    expect(listB.total).toBe(1);
    expect(listB.items.every((d) => d.accountId === "acct-B")).toBe(true);
  });

  it("insert() stamps the caller's accountId", async () => {
    const { repo } = makeRepo();
    const doc = await repo.insert(A, { name: "x" } as Omit<Doc, keyof BaseDoc>);
    expect(doc.accountId).toBe("acct-A");
  });

  it("findById() cannot read another account's document", async () => {
    const { repo } = makeRepo();
    const a = await repo.insert(A, { name: "secret-A" } as Omit<Doc, keyof BaseDoc>);
    // Same id, different account context → not found.
    expect(await repo.findById(A, a.id)).not.toBeNull();
    expect(await repo.findById(B, a.id)).toBeNull();
  });

  it("updateVersioned() cannot modify another account's document", async () => {
    const { repo } = makeRepo();
    const a = await repo.insert(A, { name: "orig" } as Omit<Doc, keyof BaseDoc>);
    await expect(repo.updateVersioned(B, a.id, a.version, { name: "hijacked" } as Partial<Doc>)).rejects.toThrow();
    // A's doc is untouched.
    const still = await repo.findById(A, a.id);
    expect(still?.name).toBe("orig");
  });

  it("softDelete() from another account does not delete the document", async () => {
    const { repo } = makeRepo();
    const a = await repo.insert(A, { name: "keep" } as Omit<Doc, keyof BaseDoc>);
    await repo.softDelete(B, a.id); // wrong account — no-op
    expect(await repo.findById(A, a.id)).not.toBeNull();
    // Correct account can delete.
    await repo.softDelete(A, a.id);
    expect(await repo.findById(A, a.id)).toBeNull();
  });

  it("countDocuments via list total is per-account", async () => {
    const { repo } = makeRepo();
    for (let i = 0; i < 5; i++) await repo.insert(A, { n: i } as Omit<Doc, keyof BaseDoc>);
    for (let i = 0; i < 3; i++) await repo.insert(B, { n: i } as Omit<Doc, keyof BaseDoc>);
    const wl = { sortable: ["createdAt"], filterable: [], searchable: [] };
    expect((await repo.list(A, {}, wl)).total).toBe(5);
    expect((await repo.list(B, {}, wl)).total).toBe(3);
  });
});
