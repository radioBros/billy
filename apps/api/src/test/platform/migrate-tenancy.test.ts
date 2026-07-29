import { describe, it, expect } from "vitest";
import { createLogger } from "@billy/shared";
import { migrateTenancy } from "@/platform/migrate-tenancy.js";

const logger = createLogger({ level: "silent", pretty: false, service: "test" });

/** Minimal in-memory Db double supporting the ops migrateTenancy uses. */
const fakeDb = (seed: Record<string, Record<string, unknown>[]>) => {
  const store: Record<string, Record<string, unknown>[]> = {};
  for (const [k, v] of Object.entries(seed)) store[k] = v.map((d) => ({ ...d }));
  const matches = (doc: Record<string, unknown>, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([key, cond]) => {
      const val = doc[key];
      if (cond && typeof cond === "object") {
        const c = cond as Record<string, unknown>;
        if ("$exists" in c) return (val !== undefined) === c.$exists;
        if ("$ne" in c) return val !== c.$ne;
        if ("$or" in c) return false; // handled at top level below
      }
      return val === cond;
    });
  const evalFilter = (doc: Record<string, unknown>, filter: Record<string, unknown>): boolean => {
    if (filter.$or) {
      return (filter.$or as Record<string, unknown>[]).some((f) => matches(doc, f)) && matches(doc, { ...filter, $or: undefined });
    }
    return matches(doc, filter);
  };
  const collection = (name: string) => {
    store[name] ??= [];
    const docs = store[name];
    return {
      async findOne(filter: Record<string, unknown>, opts?: { sort?: Record<string, 1 | -1> }) {
        let rows = docs.filter((d) => evalFilter(d, filter));
        if (opts?.sort) {
          const [f, dir] = Object.entries(opts.sort)[0] as [string, 1 | -1];
          rows = [...rows].sort((a, b) => (String(a[f]) < String(b[f]) ? -dir : dir));
        }
        return rows[0] ?? null;
      },
      async countDocuments(filter: Record<string, unknown> = {}) {
        return docs.filter((d) => evalFilter(d, filter)).length;
      },
      async insertOne(doc: Record<string, unknown>) {
        docs.push({ ...doc });
      },
      async updateMany(filter: Record<string, unknown>, update: Record<string, unknown>) {
        const set = (update.$set ?? {}) as Record<string, unknown>;
        let modifiedCount = 0;
        for (const d of docs) {
          if (evalFilter(d, filter)) {
            Object.assign(d, set);
            modifiedCount++;
          }
        }
        return { modifiedCount };
      },
      async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
        const d = docs.find((x) => evalFilter(x, filter));
        if (d) Object.assign(d, (update.$set ?? {}) as Record<string, unknown>);
        return { modifiedCount: d ? 1 : 0 };
      },
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { store, db: { collection } as any };
};

describe("migrateTenancy", () => {
  it("stamps accountId on legacy docs + attaches users + creates default account", async () => {
    const { store, db } = fakeDb({
      // Two admins so one becomes sysadmin (promotion) and the other stays an
      // account admin attached to "default".
      users: [
        { id: "u0", role: "administrator", status: "active", deletedAt: null, createdAt: "2026-01-01" },
        { id: "u1", role: "administrator", status: "active", deletedAt: null, createdAt: "2026-02-01" },
      ],
      clients: [{ id: "c1", name: "Legacy" }],
      invoices: [{ id: "i1" }],
    });
    await migrateTenancy(db, logger);

    expect(store.accounts?.[0]?.id).toBe("default");
    expect(store.clients![0]!.accountId).toBe("default");
    expect(store.invoices![0]!.accountId).toBe("default");
    // u1 (later admin) is attached to the default account.
    expect(store.users!.find((u) => u.id === "u1")!.accountId).toBe("default");
  });

  it("promotes the earliest administrator to sysadmin when none exists", async () => {
    const { store, db } = fakeDb({
      users: [
        { id: "u2", role: "administrator", status: "active", deletedAt: null, createdAt: "2026-02-01" },
        { id: "u1", role: "administrator", status: "active", deletedAt: null, createdAt: "2026-01-01" },
      ],
    });
    await migrateTenancy(db, logger);
    const u1 = store.users!.find((u) => u.id === "u1")!;
    const u2 = store.users!.find((u) => u.id === "u2")!;
    expect(u1.role).toBe("sysadmin"); // earliest by createdAt
    expect(u1.accountId).toBeNull();
    expect(u2.role).toBe("administrator");
    expect(u2.accountId).toBe("default");
  });

  it("does NOT promote when a sysadmin already exists", async () => {
    const { store, db } = fakeDb({
      users: [
        { id: "s1", role: "sysadmin", status: "active", deletedAt: null, accountId: null, createdAt: "2026-01-01" },
        { id: "a1", role: "administrator", status: "active", deletedAt: null, createdAt: "2026-01-02" },
      ],
    });
    await migrateTenancy(db, logger);
    expect(store.users!.find((u) => u.id === "a1")!.role).toBe("administrator");
  });

  it("is idempotent — a second run makes no further changes", async () => {
    const seed = {
      users: [{ id: "u1", role: "administrator", status: "active", deletedAt: null, createdAt: "2026-01-01" }],
      clients: [{ id: "c1" }],
    };
    const { store, db } = fakeDb(seed);
    await migrateTenancy(db, logger);
    const snapshot = JSON.stringify(store);
    await migrateTenancy(db, logger);
    expect(JSON.stringify(store)).toBe(snapshot);
  });
});
