import Router from "@koa/router";
import type { Db } from "mongodb";
import { z } from "zod";
import type { Logger } from "@billy/shared";
import type { AppState } from "@/app.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import { respondOk } from "@/platform/serializer.js";
import { validate } from "@/platform/validate.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import { PushService } from "@/modules/push/service.js";

/**
 * `/api/v1/push/*` — Web Push subscription management. The client subscribes via
 * the browser PushManager (with the VAPID public key), then POSTs the resulting
 * subscription here; the worker later sends notifications to it. All routes are
 * behind `requireAuth` (a subscription is owned by the current user).
 */

const SubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
const UnsubscribeSchema = z.object({ endpoint: z.string().url() });

export const createPushRouter = (deps: { db: Db; emitter: DomainEventEmitter; logger: Logger }): Router<AppState> => {
  const service = new PushService(deps.db);
  void service.ensureIndexes().catch((err) => deps.logger.warn({ err }, "push: index ensure failed"));

  const r = new Router<AppState>({ prefix: "/api/v1/push" });
  r.use(requireAuth);

  // POST /api/v1/push/subscribe — register this device's push subscription.
  r.post("/subscribe", async (ctx) => {
    const input = validate(SubscribeSchema, ctx.request.body);
    await service.subscribe(ctx.state.authContext!, input, ctx.get("user-agent"));
    respondOk(ctx, { ok: true });
  });

  // POST /api/v1/push/unsubscribe — remove this device's subscription.
  r.post("/unsubscribe", async (ctx) => {
    const { endpoint } = validate(UnsubscribeSchema, ctx.request.body);
    await service.unsubscribe(ctx.state.authContext!, endpoint);
    respondOk(ctx, { ok: true });
  });

  return r;
};
