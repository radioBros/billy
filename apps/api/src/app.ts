import Koa from "koa";
import Router from "@koa/router";
import compress from "koa-compress";
import cors from "@koa/cors";
import bodyParser from "koa-bodyparser";
import { createRequestId, errorEnvelope, errors, type Logger } from "@billy/shared";
import type { Config } from "@billy/config";
import type { AuthContext } from "@billy/types";
import type { Db } from "mongodb";
import { registerHealthRoutes, type DependencyProbes } from "@/health.js";
import { sessionMiddleware } from "@/modules/auth/middleware.js";
import { createAuthRouter } from "@/modules/auth/routes.js";
import { createGeoRouter } from "@/modules/geo/routes.js";
import { createUsersRouter } from "@/modules/auth/user-admin-routes.js";
import type { AuthService } from "@/modules/auth/auth-service.js";
import type { Principal, UserStore } from "@/modules/auth/users.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import { mountDomainModules } from "@/modules/registry.js";
import type { MinioConn } from "@/infrastructure/minio.js";
import type { QueueRegistry } from "@/platform/queue.js";
import { createPublicLinksRouter } from "@/modules/public-links/index.js";

/** Per-request state threaded through the Koa context. */
export interface AppState {
  requestId: string;
  authContext?: AuthContext;
  principal?: Principal;
}

export interface AppDeps {
  config: Config;
  logger: Logger;
  probes: DependencyProbes;
  /** When present, session-resolution middleware + `/api/v1/auth/*` routes are wired. */
  authService?: AuthService;
  /** When present (with `authService`), admin `/api/v1/users` routes are wired. */
  users?: UserStore;
  /** When present (with `emitter` + `minio`), domain-module routers are mounted under /api/v1. */
  db?: Db;
  emitter?: DomainEventEmitter;
  minio?: MinioConn;
  /** Job-queue producer; threaded to modules that enqueue (pdf-generation). */
  queue?: QueueRegistry;
}

/**
 * Koa app factory. Composes the middleware onion in a fixed order: the
 * outermost error handler, request-id + structured logging, secure headers,
 * compression, CORS, body parsing, then the session/CSRF slots and the router
 * (these must sit between logging and the router).
 */
export function createApp(deps: AppDeps): Koa<AppState> {
  const app = new Koa<AppState>();
  const { config, logger } = deps;
  // `koa-*` forwarded-header trust so `ctx.protocol`/`ctx.ip` are correct behind
  // the reverse proxy (which terminates TLS and sets X-Forwarded-*).
  app.proxy = true;

  // (1) Error handler — outermost, so it wraps every downstream throw into the
  //     canonical response envelope.
  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      const { status, body } = errorEnvelope(err);
      ctx.status = status;
      ctx.body = body;
      if (status >= 500) {
        logger.error({ err, requestId: ctx.state.requestId }, "unhandled error");
      }
    }
  });

  // (2) Request id + structured request logging.
  app.use(async (ctx, next) => {
    const requestId = ctx.get("x-request-id") || createRequestId();
    ctx.state.requestId = requestId;
    ctx.set("x-request-id", requestId);
    const start = Date.now();
    await next();
    logger.info(
      { requestId, method: ctx.method, path: ctx.path, status: ctx.status, duration: Date.now() - start },
      "request",
    );
  });

  // (3) Secure headers + response compression. These are safe baseline
  //     defaults (the full header set including CSP is layered on separately).
  app.use(async (ctx, next) => {
    ctx.set("X-Content-Type-Options", "nosniff");
    ctx.set("X-Frame-Options", "DENY");
    ctx.set("Referrer-Policy", "no-referrer");
    ctx.set("X-DNS-Prefetch-Control", "off");
    if (config.isProd) {
      ctx.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    await next();
  });
  app.use(compress());

  // (4) CORS — strict allow-list, credentials on (cookie auth). Never `*`.
  //     Binds the app origin from config.
  app.use(
    cors({
      origin: config.APP_URL,
      credentials: true,
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    }),
  );

  // (5) Body parser with size limits. File uploads are streamed in the
  //     files module, not parsed here.
  app.use(bodyParser({ jsonLimit: "1mb", formLimit: "1mb", textLimit: "1mb" }));

  // Public plane (no auth, no session, no CSRF) — tokenized read-only surface.
  // Mounted BEFORE session resolution so /public/* never runs session/CSRF; the
  // opaque token is the sole capability.
  if (deps.db && deps.emitter) {
    const publicRouter = createPublicLinksRouter({ db: deps.db, emitter: deps.emitter, logger });
    app.use(publicRouter.routes());
    app.use(publicRouter.allowedMethods());
  }

  // (6) Rate limiting (Redis store).
  // (7) Session resolution (cookie → session) → ctx.state.authContext.
  if (deps.authService) {
    app.use(sessionMiddleware(deps.authService));
  }
  // (8) CSRF verification on unsafe methods.
  // (9) Idempotency-Key + If-Match shims.

  // Router — health first; domain modules auto-register under /api/v1.
  const router = new Router<AppState>();
  registerHealthRoutes(router, deps);
  app.use(router.routes());
  app.use(router.allowedMethods());

  if (deps.authService) {
    const authRouter = createAuthRouter({ authService: deps.authService, isProd: config.isProd });
    app.use(authRouter.routes());
    app.use(authRouter.allowedMethods());

    // Admin user management. Needs the user store + emitter to build
    // its service; mounted only when both are available.
    if (deps.users && deps.emitter) {
      const usersRouter = createUsersRouter({
        users: deps.users,
        authService: deps.authService,
        emitter: deps.emitter,
        logger,
      });
      app.use(usersRouter.routes());
      app.use(usersRouter.allowedMethods());
    }
  }

  // Domain modules (clients, expenses, contracts, …, quotes, invoices, files-storage, …).
  if (deps.db && deps.emitter && deps.minio) {
    mountDomainModules(app, { db: deps.db, emitter: deps.emitter, logger, minio: deps.minio, queue: deps.queue, users: deps.users });
  }

  // Address-autocomplete proxy (Geoapify). The key stays server-side.
  const geoRouter = createGeoRouter({ apiKey: config.GEOAPIFY_API_KEY, logger });
  app.use(geoRouter.routes());
  app.use(geoRouter.allowedMethods());

  // Not-found fallthrough — unmatched routes yield the RESOURCE_NOT_FOUND envelope
  // (rather than Koa's bare 404), via the error handler above.
  app.use((ctx) => {
    throw errors.notFound(`No route for ${ctx.method} ${ctx.path}`);
  });

  return app;
}
