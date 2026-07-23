import { describe, it, expect } from "vitest";
import type { Db } from "mongodb";
import { ShareTokenStore, hashToken, SHARE_TOKENS_COLLECTION, type ShareToken } from "@/modules/public-links/share-tokens.js";

const matches = (doc: Record<string, unknown>, filter: Record<string, unknown>): boolean => {
  return Object.entries(filter).every(([k, cond]) => doc[k] === cond);
};

const fakeShareTokenDb = (): { db: Db; rows: ShareToken[] } => {
  const rows: ShareToken[] = [];
  const collection = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async createIndex() {
      return "idx";
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async insertOne(doc: ShareToken) {
      rows.push(doc);
      return { insertedId: doc.tokenHash };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async deleteMany(filter: Record<string, unknown>) {
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (matches(rows[i] as unknown as Record<string, unknown>, filter)) {
          rows.splice(i, 1);
          n++;
        }
      }
      return { deletedCount: n };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async findOne(filter: Record<string, unknown>) {
      return rows.find((r) => matches(r as unknown as Record<string, unknown>, filter)) ?? null;
    },
  };
  const db = {
    collection(name: string) {
      if (name === SHARE_TOKENS_COLLECTION) return collection;
      throw new Error(`unexpected collection ${name}`);
    },
  } as unknown as Db;
  return { db, rows };
};

describe("ShareTokenStore — mint / resolve / rotate", () => {
  it("mint → resolve round-trips to the document ref", async () => {
    const { db } = fakeShareTokenDb();
    const store = new ShareTokenStore(db);
    await store.ensureIndexes();
    const raw = await store.mint("quote", "q-1", "admin");
    expect(typeof raw).toBe("string");
    expect(raw.length).toBeGreaterThanOrEqual(20);
    const ref = await store.resolve(raw);
    expect(ref).toEqual({ documentType: "quote", documentId: "q-1" });
  });

  it("stores only the SHA-256 HASH at rest — never the raw token", async () => {
    const { db, rows } = fakeShareTokenDb();
    const store = new ShareTokenStore(db);
    const raw = await store.mint("invoice", "inv-1", "admin");
    expect(rows).toHaveLength(1);
    const stored = rows[0]!;
    expect(stored.tokenHash).toBe(hashToken(raw));
    expect(stored.tokenHash).not.toBe(raw);
    // The raw token must appear nowhere in the persisted row.
    expect(JSON.stringify(stored)).not.toContain(raw);
  });

  it("re-minting ROTATES: the old token no longer resolves, the new one does", async () => {
    const { db } = fakeShareTokenDb();
    const store = new ShareTokenStore(db);
    const first = await store.mint("quote", "q-1", "admin");
    const second = await store.mint("quote", "q-1", "admin");
    expect(second).not.toBe(first);
    expect(await store.resolve(first)).toBeNull(); // rotated away
    expect(await store.resolve(second)).toEqual({ documentType: "quote", documentId: "q-1" });
  });

  it("an unknown token → null", async () => {
    const { db } = fakeShareTokenDb();
    const store = new ShareTokenStore(db);
    await store.mint("quote", "q-1", "admin");
    expect(await store.resolve("totally-unknown-token")).toBeNull();
  });

  it("resolve returns null for a garbage token (wrong/nonexistent document)", async () => {
    const { db } = fakeShareTokenDb();
    const store = new ShareTokenStore(db);
    expect(await store.resolve("garbage")).toBeNull();
    expect(await store.resolve("")).toBeNull();
  });

  it("revokeForDocument drops the token so it stops resolving", async () => {
    const { db } = fakeShareTokenDb();
    const store = new ShareTokenStore(db);
    const raw = await store.mint("invoice", "inv-1", "admin");
    await store.revokeForDocument("invoice", "inv-1");
    expect(await store.resolve(raw)).toBeNull();
  });
});
