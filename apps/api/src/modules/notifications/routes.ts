import Router from "@koa/router";
import type { Db } from "mongodb";
import { errors, type Logger } from "@billy/shared";
import type { AppState } from "@/app.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import { validate } from "@/platform/validate.js";
import { respondList, respondOk } from "@/platform/serializer.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import {
  NotificationPreferencesRepository,
  NotificationRepository,
  NOTIFICATIONS_COLLECTION,
  PREFERENCES_COLLECTION,
} from "@/modules/notifications/repository.js";
import { NotificationService } from "@/modules/notifications/service.js";
import { PreferencesUpdateSchema } from "@/modules/notifications/schema.js";
import type { Notification, NotificationPreferences } from "@/modules/notifications/types.js";

export const createNotificationsRouter = (deps: {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
}): Router<AppState> => {
  const repo = new NotificationRepository(deps.db.collection<Notification>(NOTIFICATIONS_COLLECTION));
  const prefsRepo = new NotificationPreferencesRepository(
    deps.db.collection<NotificationPreferences>(PREFERENCES_COLLECTION),
  );
  const service = new NotificationService({
    repo,
    prefsRepo,
    emitter: deps.emitter,
    logger: deps.logger,
  });

  const r = new Router<AppState>({ prefix: "/api/v1/notifications" });

  r.use(requireAuth);

  // GET /api/v1/notifications — list the caller's own notifications (unread-first).
  r.get("/", async (ctx) => {
    const { items, meta } = await service.list(ctx.state.authContext!, ctx.query);
    respondList(ctx, items, meta);
  });

  // GET /api/v1/notifications/unread-count
  r.get("/unread-count", async (ctx) => {
    const count = await service.unreadCount(ctx.state.authContext!);
    respondOk(ctx, { count });
  });

  // GET /api/v1/notifications/preferences
  r.get("/preferences", async (ctx) => {
    const prefs = await service.getPreferences(ctx.state.authContext!);
    respondOk(ctx, prefs);
  });

  // PATCH /api/v1/notifications/preferences — merge per-category toggles
  r.patch("/preferences", async (ctx) => {
    const input = validate(PreferencesUpdateSchema, ctx.request.body);
    const prefs = await service.updatePreferences(ctx.state.authContext!, input);
    respondOk(ctx, prefs);
  });

  // POST /api/v1/notifications/read-all — mark all read
  r.post("/read-all", async (ctx) => {
    const updated = await service.markAllRead(ctx.state.authContext!);
    respondOk(ctx, { updated });
  });

  // POST /api/v1/notifications/:id/read — mark one read (idempotent)
  r.post("/:id/read", async (ctx) => {
    const notification = await service.markRead(ctx.state.authContext!, ctx.params.id!);
    if (!notification) throw errors.notFound();
    respondOk(ctx, notification);
  });

  return r;
};
