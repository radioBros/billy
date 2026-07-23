import { loadConfig } from "@billy/config";
import { createLogger } from "@billy/shared";
import { createApp } from "@/app.js";
import { createMongo } from "@/infrastructure/mongo.js";
import { createRedis } from "@/infrastructure/redis.js";
import { createMinio } from "@/infrastructure/minio.js";
import { createLoggingEmitter } from "@/platform/service.js";
import { QueueRegistry } from "@/platform/queue.js";
import { MongoUserStore, type User } from "@/modules/auth/users.js";
import { AccountRepository, ACCOUNTS_COLLECTION } from "@/modules/accounts/repository.js";
import type { Account } from "@/modules/accounts/types.js";
import { MongoSessionStore, type Session } from "@/modules/auth/sessions.js";
import { MongoTotpChallengeStore, type TotpChallenge } from "@/modules/auth/totp.js";
import { AuthService } from "@/modules/auth/auth-service.js";
import { seedFirstAdmin } from "@/modules/auth/first-run.js";
import { migrateTenancy } from "@/platform/migrate-tenancy.js";
import { createRealtime, createSubscribableEmitter } from "@/modules/realtime/index.js";
import { FILES_BUCKET } from "@/modules/files-storage/service.js";
import { startNotificationEngine } from "@/modules/notifications/engine.js";

/**
 * API entry point. Loads + validates config
 * (fail-fast), constructs dependency connections + the auth service, runs the
 * idempotent first-run admin seed, builds the app, and listens. Graceful drain
 * + connection close on SIGTERM/SIGINT.
 */
const config = loadConfig();
const logger = createLogger({ level: config.LOG_LEVEL, pretty: config.isDev, service: "api" });

const mongo = createMongo(config.MONGO_URI);
const redis = createRedis(config.REDIS_URL);
const minio = createMinio({
  endPoint: config.MINIO_ENDPOINT,
  port: config.MINIO_PORT,
  useSSL: config.MINIO_USE_SSL,
  accessKey: config.MINIO_ACCESS_KEY,
  secretKey: config.MINIO_SECRET_KEY,
  bucket: config.MINIO_BUCKET,
});

// Wrap the logging emitter so the realtime layer can subscribe to the same
// domain-event stream every service already emits into (one shared instance).
const emitter = createSubscribableEmitter(createLoggingEmitter(logger));
// Job queue producer (BullMQ). Boot-tolerant/lazy; consumed by modules that
// enqueue (email/pdf/recurring) as those land. The worker app processes them.
const queues = new QueueRegistry(config.REDIS_URL);
const users = new MongoUserStore(mongo.db.collection<User>("users"));
const sessions = new MongoSessionStore(mongo.db.collection<Session>("sessions"));
const challenges = new MongoTotpChallengeStore(mongo.db.collection<TotpChallenge>("totp_challenges"));
const accountsRepo = new AccountRepository(mongo.db.collection<Account>(ACCOUNTS_COLLECTION));
const authService = new AuthService({
  users,
  sessions,
  challenges,
  emitter,
  logger,
  encryptionKey: config.DATA_ENCRYPTION_KEY,
  // Sysadmin assume-account flow verifies the target account exists + is active.
  accounts: accountsRepo,
});

// Notification delivery engine: subscribe to the domain-event stream
// and turn a curated set of money/lifecycle events into in-app notifications for
// the actor + active admins. This is the production caller `createFromEvent` was
// missing — it's what makes the bell (and, once subscribed, web push) actually
// fill from real events.
startNotificationEngine({ db: mongo.db, emitter, users, logger, pushQueue: queues });

// Self-provision the files bucket (idempotent). Replaces the old `minio-init`
// sidecar — a fresh install needs no init container or manual `mc mb`. Guarded so
// a down/slow MinIO doesn't crash boot; readiness reports it and the next boot retries.
try {
  await minio.ensureBucket(FILES_BUCKET);
  logger.info({ bucket: FILES_BUCKET }, "minio: files bucket ensured (private)");
} catch (err) {
  logger.warn({ err }, "minio: bucket ensure skipped (object store unavailable at boot)");
}

// Multi-account backfill (idempotent). Runs BEFORE first-run seed: on an existing
// single-tenant install it stamps accountId on legacy data + guarantees a sysadmin
// exists (that install skips the seed below); on a fresh DB it is a near-no-op and
// the seed creates the sysadmin.
try {
  await migrateTenancy(mongo.db, logger);
} catch (err) {
  logger.warn({ err }, "tenancy migration skipped (datastore unavailable at boot)");
}

// First-run admin seed (idempotent). Guarded so a down Mongo doesn't crash boot;
// readiness will report the datastore and the seed retries next boot.
try {
  await seedFirstAdmin({
    users,
    emitter,
    logger,
    email: config.BOOTSTRAP_ADMIN_EMAIL,
    password: config.BOOTSTRAP_ADMIN_PASSWORD,
  });
} catch (err) {
  logger.warn({ err }, "first-run seed skipped (datastore unavailable at boot)");
}

const app = createApp({
  config,
  logger,
  authService,
  users,
  db: mongo.db,
  emitter,
  minio,
  queue: queues,
  probes: {
    mongodb: () => mongo.ping(),
    redis: () => redis.ping(),
    minio: () => minio.ping(),
  },
});

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.APP_ENV }, "api listening");
});

// Realtime WS server: shares this http server/port; authenticates handshakes
// with the same session cookie as HTTP (authService.resolve); pushes domain
// events to the owning user's room only.
const realtime = createRealtime({
  httpServer: server,
  emitter,
  sessionResolver: authService,
  logger,
  config,
});

let shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, "shutting down");
    void realtime.close().finally(() => {
      server.close(() => {
        void Promise.allSettled([mongo.close(), redis.close(), queues.close()]).then(() => process.exit(0));
      });
    });
  });
}
