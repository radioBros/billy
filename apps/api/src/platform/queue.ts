import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import {
  QUEUE_NAME_LIST,
  type JobPayloads,
  type QueueName,
} from "@billy/types";

/**
 * API-side enqueue surface. The API **only
 * enqueues** — no queue is processed in this process (worker
 * isolation). One BullMQ `Queue` is built per canonical queue name over a
 * shared ioredis connection.
 *
 * Boot-tolerant: the connection is lazy (mirrors infrastructure/redis.ts) so a
 * down Redis does not crash API boot; enqueue fails fast with a connection error
 * that the caller maps to `QUEUE_UNAVAILABLE`.
 */

/**
 * Default retry policy: 5 attempts, exponential backoff. (Jitter would need a
 * custom backoff strategy registered on the Worker, a later item; the built-in
 * `exponential` has none.)
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1000 },
  // Keep a bounded history so completed/failed jobs are inspectable but Redis
  // does not grow unbounded (failed jobs are the DLQ surface).
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export const buildJobId = (queue: QueueName, parts: readonly string[]): string => {
  return [queue, ...parts].join(":");
};

/** Options accepted by {@link QueueRegistry.enqueue}. */
export interface EnqueueOptions {
  /**
   * Stable parts that make this job unique; joined into a deterministic `jobId`
   * (see {@link buildJobId}). Omit for fire-and-forget jobs with no natural key.
   */
  idempotencyParts?: readonly string[];
  /** Per-job BullMQ overrides, merged over {@link DEFAULT_JOB_OPTIONS}. */
  jobOptions?: JobsOptions;
}

/** A Redis connection dependency: either a URL string or a live ioredis instance. */
export type RedisDependency = string | Redis;

export class QueueRegistry {
  readonly #connection: Redis;
  /** True when we created the connection (so `close()` disconnects it). */
  readonly #ownsConnection: boolean;
  readonly #queues = new Map<QueueName, Queue>();

  constructor(redis: RedisDependency) {
    if (typeof redis === "string") {
      // BullMQ requires `maxRetriesPerRequest: null` on its connection.
      this.#connection = new Redis(redis, {
        lazyConnect: true,
        maxRetriesPerRequest: null,
        retryStrategy: (times) => Math.min(times * 200, 2000),
      });
      this.#connection.on("error", () => {});
      this.#ownsConnection = true;
    } else {
      this.#connection = redis;
      this.#ownsConnection = false;
    }
    for (const name of QUEUE_NAME_LIST) {
      this.#queues.set(name, new Queue(name, { connection: this.#connection }));
    }
  }

  /** The `Queue` for `name` (always present — one per canonical name). */
  #queue(name: QueueName): Queue {
    const q = this.#queues.get(name);
    if (!q) throw new Error(`unknown queue: ${name}`);
    return q;
  }

  /**
   * Enqueue a typed job. The payload type is pinned to the queue name via
   * {@link JobPayloads}, so a mismatched payload is a compile error. Applies the
   * default retry policy and, when `idempotencyParts` are given, a deterministic
   * `jobId` so retries / double-submits do not duplicate work.
   */
  async enqueue<Q extends QueueName>(
    name: Q,
    payload: JobPayloads[Q],
    opts: EnqueueOptions = {},
  ): Promise<string> {
    const jobId = opts.idempotencyParts
      ? buildJobId(name, opts.idempotencyParts)
      : undefined;
    const job = await this.#queue(name).add(name, payload, {
      ...DEFAULT_JOB_OPTIONS,
      ...opts.jobOptions,
      ...(jobId ? { jobId } : {}),
    });
    // `job.id` is assigned by BullMQ on add; fall back to the deterministic id.
    return job.id ?? jobId ?? "";
  }

  /** Close all queues and, if we own it, the underlying connection. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.#queues.values()].map((q) => q.close()));
    if (this.#ownsConnection) {
      this.#connection.disconnect();
    }
  }
}
