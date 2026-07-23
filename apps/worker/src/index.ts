import { loadConfig } from "@billy/config";
import { createLogger } from "@billy/shared";
import { QUEUE_NAME_LIST, type JobPayloads, type QueueName } from "@billy/types";
import { Worker, Queue, type Job } from "bullmq";
import { Redis } from "ioredis";
import { MongoClient } from "mongodb";
import { createProcessors, type ProcessorContext, type ProcessorRegistry } from "@/processors.js";

/**
 * Worker entry point. A
 * thin Node runtime that connects Mongo + Redis and registers one BullMQ
 * `Worker` per queue over the processor registry. It is a pure queue consumer:
 *
 *   NO HTTP LISTENER — the worker never binds a port;
 *   it does async work isolated from the API request path.
 *
 * Graceful shutdown drains in-flight jobs on SIGTERM/SIGINT before exit.
 */

const config = loadConfig();
const logger = createLogger({ level: config.LOG_LEVEL, pretty: config.isDev, service: "worker" });

// ── Connections ──────────────────────────────────────────────────────────────
// Lazy/boot-tolerant like the API (infrastructure/redis.ts, mongo.ts): a down
// datastore must not crash worker boot. BullMQ requires `maxRetriesPerRequest:
// null` on its connection.
const mongoClient = new MongoClient(config.MONGO_URI, { serverSelectionTimeoutMS: 2000 });
const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});
redis.on("error", (err) => logger.debug({ err }, "redis connection error"));

// ── Processor registry → one Worker per queue ─────────────────────────────────
const processors: ProcessorRegistry = createProcessors();
const ctx: ProcessorContext = { logger };

const workers: Worker[] = QUEUE_NAME_LIST.map((name) => {
  // Narrow the handler to the queue's payload type. The registry is keyed by the
  // same names, so the cast is sound (mapped-type guarantee in processors.ts).
  const handler = processors[name];
  const worker = new Worker(
    name,
    async (job: Job<JobPayloads[QueueName]>) => handler(job.data as never, ctx),
    { connection: redis, autorun: true },
  );
  worker.on("completed", (job) => logger.info({ queue: name, jobId: job.id }, "job completed"));
  worker.on("failed", (job, err) =>
    logger.error({ queue: name, jobId: job?.id, attemptsMade: job?.attemptsMade, err }, "job failed"),
  );
  return worker;
});

logger.info({ queues: QUEUE_NAME_LIST }, "worker registered queue consumers");

/**
 * SINGLE SCHEDULER OWNER.
 *
 * Exactly ONE process registers BullMQ repeatable/scheduled jobs — this worker.
 * A dedicated `scheduler` container is a v2 scale
 * option that, if enabled, becomes the SOLE owner; there are never two
 * registrars double-firing. This hook is intentionally empty at the framework
 * stage: the recurring-scheduler section fills it with the repeatable jobs
 * (recurring-invoice every 15m, hourly scanners, daily cleanup/backup/health).
 * Repeatable-job keys make re-registration across restarts idempotent.
 */
async function registerRepeatables(): Promise<void> {
  // Scheduled-send + recurring tick. A repeatable job on the `recurring`
  // queue fires every 15 minutes; its handler (handlers/recurring.ts) scans for
  // `scheduled` invoices whose date has arrived and finalizes them under a system
  // context. A fixed jobId + repeat key makes re-registration across restarts
  // idempotent (no duplicate schedules). Guarded so a down Redis doesn't crash boot.
  try {
    const recurringQueue = new Queue("recurring", { connection: redis });
    await recurringQueue.add(
      "recurring-tick",
      { recurringProfileId: "*", scheduledOccurrenceDate: "*", accountId: "default" } as never,
      {
        repeat: { every: 15 * 60 * 1000 }, // every 15 minutes
        jobId: "recurring-tick", // stable → idempotent re-registration
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
    logger.info("repeatable jobs registered (recurring-tick every 15m)");
  } catch (err) {
    logger.warn({ err }, "repeatable job registration skipped (Redis unavailable at boot)");
  }
}

await registerRepeatables();

// ── Graceful shutdown (drain in-flight, then close connections) ───────────────
let shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, "shutting down — draining workers");
    void (async () => {
      // `Worker.close()` waits for the current job to finish (drain) before resolving.
      await Promise.allSettled(workers.map((w) => w.close()));
      await Promise.allSettled([mongoClient.close(), redis.quit()]);
      process.exit(0);
    })();
  });
}
