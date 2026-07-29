import Router from "@koa/router";
import type { Db } from "mongodb";
import { errors } from "@billy/shared";
import type { Logger } from "@billy/shared";
import type { ListMeta } from "@billy/types";
import type { AppState } from "@/app.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import { validate } from "@/platform/validate.js";
import { respondOk, respondCreated, respondList, stripFinancial, stripFinancialList } from "@/platform/serializer.js";
import type { AuthContext } from "@billy/types";
import { requireAuth } from "@/modules/auth/middleware.js";
import { SubscriptionRepository, SUBSCRIPTIONS_COLLECTION } from "@/modules/subscriptions/repository.js";
import { SubscriptionService } from "@/modules/subscriptions/service.js";
import type { Subscription } from "@/modules/subscriptions/types.js";
import { SUBSCRIPTION_FINANCIAL_FIELDS } from "@/modules/subscriptions/types.js";
import { SubscriptionCreateSchema, SubscriptionUpdateSchema, SUBSCRIPTION_LIST_WHITELIST } from "@/modules/subscriptions/schema.js";

export const createSubscriptionsRouter = (deps: {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
}): Router<AppState> => {
  const repo = new SubscriptionRepository(deps.db.collection<Subscription>(SUBSCRIPTIONS_COLLECTION));
  const service = new SubscriptionService({ repo, emitter: deps.emitter, logger: deps.logger });

  const r = new Router<AppState>({ prefix: "/api/v1/subscriptions" });
  r.use(requireAuth);

  const authOf = (ctx: { state: AppState }) => {
    const auth = ctx.state.authContext;
    if (!auth) throw errors.unauthenticated();
    return auth;
  };

  /** Optimistic-concurrency version from If-Match header or body. */
  const requireVersion = (ctx: { get(f: string): string; request: { body?: unknown } }): number => {
    const header = ctx.get("if-match").replace(/^["']|["']$/g, "").trim();
    const body = (ctx.request.body ?? {}) as { version?: unknown };
    const raw = header !== "" ? header : body.version;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw errors.validation("Missing or invalid version (If-Match)", { version: "version.required" });
    }
    return n;
  };

  const idOf = (params: { id?: string }): string => {
    const id = params.id;
    if (!id) throw errors.notFound("Missing subscription id");
    return id;
  };

  /** Strip financial fields for the caller (serializer takes an index type). */
  const present = (auth: AuthContext, doc: Subscription): Subscription =>
    stripFinancial(auth, doc as unknown as Record<string, unknown>, SUBSCRIPTION_FINANCIAL_FIELDS) as unknown as Subscription;

  // GET / — list (grammar + whitelist)
  r.get("/", async (ctx) => {
    const auth = authOf(ctx);
    const { items, parsed, total } = await service.list(auth, ctx.query, SUBSCRIPTION_LIST_WHITELIST);
    const meta: ListMeta = {
      page: parsed.page,
      limit: parsed.limit,
      total,
      pageCount: Math.ceil(total / parsed.limit),
      sort: parsed.sortSpec,
      ...(parsed.q ? { q: parsed.q } : {}),
    };
    respondList(
      ctx,
      stripFinancialList(auth, items as unknown as Record<string, unknown>[], SUBSCRIPTION_FINANCIAL_FIELDS),
      meta,
    );
  });

  // POST / — create
  r.post("/", async (ctx) => {
    const auth = authOf(ctx);
    const input = validate(SubscriptionCreateSchema, ctx.request.body);
    const created = await service.create(auth, input);
    respondCreated(ctx, present(auth, created));
  });

  // GET /:id
  r.get("/:id", async (ctx) => {
    const auth = authOf(ctx);
    const doc = await service.get(auth, idOf(ctx.params));
    respondOk(ctx, present(auth, doc));
  });

  // PATCH /:id — versioned update
  r.patch("/:id", async (ctx) => {
    const auth = authOf(ctx);
    const version = requireVersion(ctx);
    const input = validate(SubscriptionUpdateSchema, ctx.request.body);
    const updated = await service.update(auth, idOf(ctx.params), version, input);
    respondOk(ctx, present(auth, updated));
  });

  // DELETE /:id — soft-delete
  r.delete("/:id", async (ctx) => {
    const auth = authOf(ctx);
    await service.softDelete(auth, idOf(ctx.params));
    respondOk(ctx, { ok: true });
  });

  // Lifecycle + status actions (all versioned)
  const action =
    (fn: (id: string, version: number, auth: AuthContext) => Promise<Subscription>) =>
    async (ctx: import("koa").ParameterizedContext<AppState>) => {
      const auth = authOf(ctx);
      const version = requireVersion(ctx);
      const updated = await fn(idOf(ctx.params as { id?: string }), version, auth);
      respondOk(ctx, present(auth, updated));
    };

  r.post("/:id/archive", action((id, v, a) => service.archive(a, id, v)));
  r.post("/:id/restore", action((id, v, a) => service.restore(a, id, v)));
  r.post("/:id/pause", action((id, v, a) => service.pause(a, id, v)));
  r.post("/:id/resume", action((id, v, a) => service.resume(a, id, v)));
  r.post("/:id/cancel", action((id, v, a) => service.cancel(a, id, v)));
  r.post("/:id/mark-paid", action((id, v, a) => service.markPaid(a, id, v)));

  return r;
};
