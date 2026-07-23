import type { Logger } from "@billy/shared";
import type { NotificationJob } from "@billy/types";
import { MongoClient } from "mongodb";
import webpush from "web-push";
import type { ProcessorContext } from "@/processors.js";

/**
 * Web Push send handler (push channel).
 *
 * Runs ONLY in the worker (isolation — the API composes + enqueues the
 * thin NotificationJob { userId, eventType, entityId, accountId }; THIS
 * performs the actual fan-out to the user's devices). It:
 *   1. inits web-push with VAPID from env once, lazily + guarded — if
 *      VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY is missing, push is DISABLED: the
 *      handler logs once and no-ops (a queued job must not dead-letter just
 *      because this deployment hasn't configured push),
 *   2. re-reads the in-app notification doc (the job is thin by design) to get
 *      the rendered title/body — the most recent `notifications` row matching
 *      (userId, entityId, type=eventType), newest first; falls back to a generic
 *      title derived from eventType when none is found,
 *   3. loads the user's push subscriptions (`pushSubscriptions`, one per device),
 *   4. sends the SW payload to each; PRUNES dead endpoints on 404/410 (Gone) by
 *      deleting the subscription doc, logs + continues on other per-send errors
 *      so one bad device never fails the whole job.
 *
 * SW PAYLOAD SHAPE (the frontend service-worker `push` handler MUST match this):
 *   { title: string, body: string, data: { url: string } }
 * The SW reads `title`/`body` for `showNotification(title, { body, data })` and
 * `data.url` for the click-through target (notificationclick).
 */

const NOTIFICATIONS_COLLECTION = "notifications";
const PUSH_SUBSCRIPTIONS_COLLECTION = "pushSubscriptions";

/** The SW push payload envelope — coordinate with the frontend service worker. */
export interface PushPayload {
  title: string;
  body: string;
  data: { url: string };
}

/** Subset of the in-app Notification doc this handler reads for title/body/link. */
interface NotificationDoc {
  title?: string | null;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  type?: string | null;
}

/** Subset of a stored push subscription (see api push/service.ts PushSubscriptionRecord). */
interface PushSubscriptionDoc {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// ── VAPID init (lazy, once, guarded) ─────────────────────────────────────────
// State is module-level so repeated jobs don't re-init or re-log the disabled
// warning. `disabledLogged` guards the "push disabled" line to a single emission.
let vapidConfigured = false;
let pushDisabled = false;
let disabledLogged = false;

const ensureVapid = (logger: Logger): boolean => {
  if (vapidConfigured) return true;
  if (pushDisabled) return false;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@billy.local";
  if (!publicKey || !privateKey) {
    pushDisabled = true;
    if (!disabledLogged) {
      disabledLogged = true;
      logger.info({ queue: "notifications" }, "push disabled (no VAPID keys)");
    }
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  return true;
};

// ── Lazy Mongo (mirrors handlers/pdf.ts getMongo()) ──────────────────────────
let mongoClient: MongoClient | null = null;

const getMongo = (): MongoClient => {
  if (!mongoClient) {
    const uri = process.env.MONGO_URI ?? "mongodb://localhost:27017/billy";
    mongoClient = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  }
  return mongoClient;
};

const fallbackTitle = (eventType: string): string => {
  const words = eventType.replace(/[._-]+/g, " ").trim();
  if (!words) return "Notification";
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const deepLink = (doc: NotificationDoc | null, payload: NotificationJob): string => {
  const entityType = doc?.entityType ?? undefined;
  const entityId = doc?.entityId ?? payload.entityId;
  const routeByType: Record<string, string> = {
    invoice: "/invoices",
    quote: "/quotes",
    proforma: "/proformas",
    "credit-note": "/credit-notes",
    creditNote: "/credit-notes",
    contract: "/contracts",
    expense: "/expenses",
    subscription: "/subscriptions",
  };
  const base = entityType ? routeByType[entityType] : undefined;
  if (base && entityId) return `${base}/${entityId}`;
  return "/notifications";
};

const findNotificationDoc = async (payload: NotificationJob): Promise<NotificationDoc | null> => {
  const db = getMongo().db();
  const doc = await db
    .collection<NotificationDoc>(NOTIFICATIONS_COLLECTION)
    .findOne(
      { userId: payload.userId, entityId: payload.entityId, type: payload.eventType } as never,
      { projection: { _id: 0 }, sort: { createdAt: -1 } },
    );
  return (doc as NotificationDoc | null) ?? null;
};

const loadSubscriptions = async (userId: string): Promise<PushSubscriptionDoc[]> => {
  const db = getMongo().db();
  const docs = await db
    .collection<PushSubscriptionDoc>(PUSH_SUBSCRIPTIONS_COLLECTION)
    .find({ userId } as never, { projection: { _id: 0, endpoint: 1, keys: 1 } })
    .toArray();
  return docs as PushSubscriptionDoc[];
};

const pruneSubscription = async (endpoint: string): Promise<void> => {
  const db = getMongo().db();
  await db.collection(PUSH_SUBSCRIPTIONS_COLLECTION).deleteOne({ endpoint } as never);
};

export interface PushHandlerResult {
  /** How many devices were sent to successfully. */
  sent: number;
  /** How many dead endpoints were pruned (410/404). */
  pruned: number;
  /** Total subscriptions considered. */
  total: number;
  /** True when push was skipped because VAPID is not configured. */
  disabled?: boolean;
}

export const pushHandler = async (payload: NotificationJob, ctx: ProcessorContext): Promise<PushHandlerResult> => {
  const logger: Logger = ctx.logger;

  if (!ensureVapid(logger)) {
    return { sent: 0, pruned: 0, total: 0, disabled: true };
  }

  // Re-read the rendered title/body (the job is thin) — fall back to a generic
  // title from the event type when no matching notification doc exists.
  const doc = await findNotificationDoc(payload);
  const title = (doc?.title && doc.title.trim()) || fallbackTitle(payload.eventType);
  const body = doc?.body?.trim() || "";
  const url = deepLink(doc, payload);

  const subscriptions = await loadSubscriptions(payload.userId);
  if (subscriptions.length === 0) {
    logger.info(
      { queue: "notifications", userId: payload.userId, eventType: payload.eventType },
      "no push subscriptions — nothing to send",
    );
    return { sent: 0, pruned: 0, total: 0 };
  }

  const message: PushPayload = { title, body, data: { url } };
  const serialized = JSON.stringify(message);

  let sent = 0;
  let pruned = 0;
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        serialized,
      );
      sent += 1;
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        // Endpoint is Gone — prune it so we stop sending to a dead device.
        try {
          await pruneSubscription(sub.endpoint);
          pruned += 1;
        } catch (pruneErr) {
          logger.warn(
            { queue: "notifications", endpoint: sub.endpoint, err: pruneErr },
            "failed to prune dead push subscription",
          );
        }
      } else {
        // Other errors: log + continue so one bad device never fails the job.
        logger.warn(
          { queue: "notifications", endpoint: sub.endpoint, statusCode, err },
          "push send failed for one subscription — continuing",
        );
      }
    }
  }

  logger.info(
    { queue: "notifications", userId: payload.userId, eventType: payload.eventType, sent, pruned, total: subscriptions.length },
    "push notifications sent",
  );
  return { sent, pruned, total: subscriptions.length };
};
