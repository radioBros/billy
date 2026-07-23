import Router from "@koa/router";
import type { Db } from "mongodb";
import { AppError, type Logger } from "@billy/shared";
import type { AppState } from "@/app.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import { respondOk } from "@/platform/serializer.js";
import { PublicLinkService } from "@/modules/public-links/service.js";
import { ShareTokenStore } from "@/modules/public-links/share-tokens.js";
import { createInMemoryRateLimiter, DEFAULT_PUBLIC_RATE_LIMIT } from "@/modules/public-links/rate-limit.js";
import type { RateLimiter } from "@/modules/public-links/types.js";

export const createPublicLinksRouter = (deps: {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
  rateLimiter?: RateLimiter;
}): Router<AppState> => {
  const service = new PublicLinkService({
    db: deps.db,
    emitter: deps.emitter,
    logger: deps.logger,
    shareTokens: new ShareTokenStore(deps.db),
  });
  const rateLimiter = deps.rateLimiter ?? createInMemoryRateLimiter(DEFAULT_PUBLIC_RATE_LIMIT);

  const r = new Router<AppState>({ prefix: "/public" });

  // Strict per-token + per-IP rate limit. Runs BEFORE lookup so scanning is
  // bounded before any DB work. On exceed → 429 RATE_LIMITED with Retry-After.
  //
  // NOTE: `@koa/router` populates `ctx.params` only inside the matched ROUTE
  // layer — a `router.use()` middleware runs earlier, where `ctx.params.token`
  // is still undefined. So the token is parsed from the path here (not params),
  // otherwise the key would collapse to IP-only and break per-token limiting.
  r.use(async (ctx, next) => {
    const token = extractToken(ctx.path);
    const key = `${token}:${ctx.ip}`;
    const limited = rateLimiter.check(key);
    if (limited) {
      // Set Retry-After BEFORE throwing — the app.ts error handler preserves headers.
      ctx.set("Retry-After", String(limited.retryAfterSeconds));
      throw new AppError("RATE_LIMITED", "Too many requests");
    }
    // Anti-index / anti-referrer-leak hardening for the public surface.
    ctx.set("X-Robots-Tag", "noindex, nofollow");
    ctx.set("Referrer-Policy", "no-referrer");
    await next();
  });

  // GET /public/quotes/:token — read-only public quote projection.
  r.get("/quotes/:token", async (ctx) => {
    respondOk(ctx, await service.getQuote(ctx.params.token!));
  });

  // POST /public/quotes/:token/accept — idempotent sent→accepted.
  r.post("/quotes/:token/accept", async (ctx) => {
    respondOk(ctx, await service.acceptQuote(ctx.params.token!));
  });

  // POST /public/quotes/:token/decline — idempotent sent→declined.
  r.post("/quotes/:token/decline", async (ctx) => {
    respondOk(ctx, await service.declineQuote(ctx.params.token!));
  });

  // GET /public/invoices/:token — read-only public invoice projection.
  r.get("/invoices/:token", async (ctx) => {
    respondOk(ctx, await service.getInvoice(ctx.params.token!));
  });

  return r;
};

const extractToken = (path: string): string => {
  const m = /^\/public\/(?:quotes|invoices)\/([^/]+)/u.exec(path);
  return m?.[1] ? decodeURIComponent(m[1]) : "";
};
