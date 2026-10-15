import type { Db } from "mongodb";
import type { AuthContext } from "@billy/types";

/**
 * Tiny in-memory stand-in for the Mongo driver surface the repositories + routers
 * use (findOne / insertOne / findOneAndUpdate / updateOne / createIndex). Filters
 * support plain equality plus `$in` / `$ne`; updates support `$set` / `$inc`.
 * Enough to drive a real router → service → repository chain in a unit test.
 */
export type Doc = Record<string, unknown>;

const matches = (doc: Doc, filter: Doc): boolean =>
  Object.entries(filter).every(([k, cond]) => {
    const v = doc[k] ?? null;
    if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
      const c = cond as Doc;
      if ("$in" in c) return ((c.$in as unknown[]) ?? []).includes(v);
      if ("$ne" in c) return v !== (c.$ne ?? null);
    }
    return v === (cond ?? null);
  });

const strip = (d: Doc | undefined | null): Doc | null => {
  if (!d) return null;
  const { _id: _ignored, ...rest } = d;
  void _ignored;
  return { ...rest };
};

export class FakeCollection {
  constructor(readonly docs: Doc[] = []) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async findOne(filter: Doc): Promise<Doc | null> {
    return strip(this.docs.find((d) => matches(d, filter)));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async insertOne(doc: Doc): Promise<{ insertedId: unknown }> {
    this.docs.push({ ...doc });
    return { insertedId: doc.id };
  }

  private apply(doc: Doc, update: Doc): void {
    for (const [k, val] of Object.entries((update.$set as Doc) ?? {})) doc[k] = val;
    for (const [k, val] of Object.entries((update.$inc as Doc) ?? {})) doc[k] = (Number(doc[k]) || 0) + Number(val);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findOneAndUpdate(filter: Doc, update: Doc): Promise<Doc | null> {
    const doc = this.docs.find((d) => matches(d, filter));
    if (!doc) return null;
    this.apply(doc, update);
    return strip(doc);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async updateOne(filter: Doc, update: Doc): Promise<{ modifiedCount: number }> {
    const doc = this.docs.find((d) => matches(d, filter));
    if (!doc) return { modifiedCount: 0 };
    this.apply(doc, update);
    return { modifiedCount: 1 };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async createIndex(): Promise<string> {
    return "idx";
  }
}

export const fakeMongo = (seed: Record<string, Doc[]> = {}): { db: Db; col: (name: string) => FakeCollection } => {
  const collections: Record<string, FakeCollection> = {};
  for (const [name, docs] of Object.entries(seed)) collections[name] = new FakeCollection(docs);
  const col = (name: string): FakeCollection => (collections[name] ??= new FakeCollection());
  return { db: { collection: col } as unknown as Db, col };
};

/** Minimal Koa-ish ctx for driving a `@koa/router` router directly. */
export interface FakeCtx {
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

export const fakeCtx = (auth: AuthContext, opts: { method: string; path: string; params: Record<string, string>; body?: unknown }): FakeCtx => ({
  method: opts.method,
  path: opts.path,
  url: opts.path,
  params: opts.params,
  query: {},
  request: { body: opts.body },
  headers: {},
  get: () => "",
  set: () => undefined,
  status: 404,
  body: undefined,
  state: { authContext: auth },
});

/** Drive a router's `routes()` middleware with a fake ctx. */
export const driveRouter = (router: { routes(): (ctx: never, next: never) => Promise<unknown> }) => {
  const dispatch = router.routes();
  return async (ctx: FakeCtx): Promise<void> => {
    await dispatch(ctx as never, (async () => undefined) as never);
  };
};
