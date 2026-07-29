import { MongoClient, type Db } from "mongodb";

/**
 * MongoDB connection. Constructed eagerly but the
 * driver connects lazily, so the app boots even when Mongo is down — readiness
 * then reports it via `ping()`. Shared by api + worker (hoisted to a shared
 * infra package when the worker app lands).
 */
export interface MongoConn {
  client: MongoClient;
  db: Db;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export const createMongo = (uri: string): MongoConn => {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  return {
    client,
    db: client.db(),
    async ping() {
      await client.db().command({ ping: 1 });
    },
    async close() {
      await client.close();
    },
  };
};
