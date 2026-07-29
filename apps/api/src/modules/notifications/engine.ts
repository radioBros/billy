import type { Db } from "mongodb";
import type { Logger } from "@billy/shared";
import type { DomainEvent } from "@/platform/service.js";
import type { SubscribableEmitter } from "@/modules/realtime/emitter.js";
import type { UserStore } from "@/modules/auth/users.js";
import {
  NotificationRepository,
  NotificationPreferencesRepository,
  NOTIFICATIONS_COLLECTION,
  PREFERENCES_COLLECTION,
} from "@/modules/notifications/repository.js";
import { NotificationService, type NotificationPushQueue } from "@/modules/notifications/service.js";
import type { Notification, NotificationPreferences } from "@/modules/notifications/types.js";

/**
 * Notification delivery engine. Subscribes to the in-process domain
 * event stream and, for a CURATED set of key money/lifecycle events, creates
 * in-app notifications for the right recipients. This is the trigger that was
 * missing — `createFromEvent` now has a production caller.
 *
 * Recipient policy (operator-chosen): the ACTOR (whoever caused the event, when
 * known) PLUS all active administrators, de-duplicated. Keeps the bell useful on
 * a small team without spamming every user on every `.updated`.
 *
 * Curated events only (no `.created`/`.updated` firehose): the meaningful money
 * + lifecycle moments. `notification.created`/`notification.updated` are
 * EXCLUDED (they're emitted BY this pipeline → would loop).
 */
const NOTIFY_EVENTS: ReadonlySet<string> = new Set([
  "invoice.finalized",
  "invoice.paid",
  "invoice.void",
  "invoice.scheduled",
  "quote.sent",
  "quote.accepted",
  "quote.declined",
  "quote.converted",
  "payment.received",
  "contract.renewed",
  "recurring.occurrence_generated",
]);

export interface NotificationEngineDeps {
  db: Db;
  emitter: SubscribableEmitter;
  users: Pick<UserStore, "listActiveAdminIds" | "findById">;
  logger: Logger;
  /** When present, each created notification also enqueues a web-push job. */
  pushQueue?: NotificationPushQueue;
}

export const startNotificationEngine = (deps: NotificationEngineDeps): () => void => {
  const repo = new NotificationRepository(deps.db.collection<Notification>(NOTIFICATIONS_COLLECTION));
  const prefsRepo = new NotificationPreferencesRepository(
    deps.db.collection<NotificationPreferences>(PREFERENCES_COLLECTION),
  );
  const service = new NotificationService({
    repo,
    prefsRepo,
    emitter: deps.emitter,
    logger: deps.logger,
    pushQueue: deps.pushQueue,
  });

  const handle = async (event: DomainEvent): Promise<void> => {
    if (!NOTIFY_EVENTS.has(event.name)) return;
    try {
      // Resolve the event's account from the actor so notification recipients are
      // scoped to the SAME account (no cross-tenant admin notifications). A null
      // actor (system/public action) yields no admin fan-out — only the actor (none),
      // which is correct: system events have no per-account admin target here.
      const actor = event.actorId ? await deps.users.findById(event.actorId) : null;
      const accountId = actor?.accountId ?? null;
      // No resolvable account (system/public action with no account-bound actor)
      // → no in-app fan-out. Notifications are per-account; we cannot stamp one
      // without the recipient's real account (fail-closed stamps it on insert).
      if (!accountId) return;
      const admins = await deps.users.listActiveAdminIds(accountId);
      // actor + admins, de-duplicated. All share `accountId` (same account).
      const recipients = [...new Set([...(event.actorId ? [event.actorId] : []), ...admins])];
      if (recipients.length === 0) return;
      // createFromEvent writes per-recipient, stamping each with `accountId` so
      // the recipient can read it back under their own account scope.
      await service.createFromEvent(event, recipients, accountId);
    } catch (err) {
      deps.logger.warn({ err, event: event.name }, "notification-engine: create failed (non-fatal)");
    }
  };

  const unsubscribe = deps.emitter.on((event) => {
    void handle(event);
  });
  deps.logger.info({ events: [...NOTIFY_EVENTS] }, "notification engine started (event → in-app notifications)");
  return unsubscribe;
};
