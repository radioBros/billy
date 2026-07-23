import { Redis } from "ioredis";

/**
 * Redis connection (sessions cache, BullMQ, idempotency). `lazyConnect` + a
 * bounded retry so a down Redis doesn't crash boot or spam reconnects; `ping()`
 * establishes/validates the connection for readiness.
 */
export interface RedisConn {
  redis: Redis;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export const createRedis = (url: string): RedisConn => {
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  // Swallow background connection errors — readiness surfaces them via ping().
  redis.on("error", () => {});
  return {
    redis,
    async ping() {
      if (redis.status !== "ready") {
        await redis.connect();
      }
      const pong = await redis.ping();
      if (pong !== "PONG") throw new Error("redis ping failed");
    },
    async close() {
      redis.disconnect();
    },
  };
};
