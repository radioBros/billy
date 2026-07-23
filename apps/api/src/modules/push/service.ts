import type { Collection, Db } from "mongodb";
import { randomUUID } from "node:crypto";
import type { AuthContext } from "@billy/types";

/**
 * Web-push subscription store. A user has MANY subscriptions —
 * one per device/browser — so we key on the endpoint (unique) and scope reads by
 * userId. The WORKER reads these to fan a notification out as push messages; this
 * api-side service only records/removes them. Dead endpoints (410/404 Gone) are
 * pruned by the worker at send time, plus an explicit unsubscribe here.
 */

export const PUSH_SUBSCRIPTIONS_COLLECTION = "pushSubscriptions";

export interface PushSubscriptionRecord {
  id: string;
  userId: string;
  /** The push service endpoint URL (unique per device). */
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string | null;
  createdAt: string;
}

/** The browser PushSubscription JSON shape the client POSTs. */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export class PushService {
  private readonly col: Collection<PushSubscriptionRecord>;
  constructor(db: Db) {
    this.col = db.collection<PushSubscriptionRecord>(PUSH_SUBSCRIPTIONS_COLLECTION);
  }

  async ensureIndexes(): Promise<void> {
    await this.col.createIndex({ endpoint: 1 }, { unique: true });
    await this.col.createIndex({ userId: 1 });
  }

  /** Upsert a subscription for the current user (idempotent on endpoint). */
  async subscribe(ctx: AuthContext, sub: PushSubscriptionInput, userAgent?: string | null): Promise<void> {
    const now = new Date().toISOString();
    await this.col.updateOne(
      { endpoint: sub.endpoint },
      {
        $set: { userId: ctx.userId, endpoint: sub.endpoint, keys: sub.keys, userAgent: userAgent ?? null },
        $setOnInsert: { id: randomUUID(), createdAt: now },
      },
      { upsert: true },
    );
  }

  /** Remove a subscription by endpoint (device opted out / token rotated). */
  async unsubscribe(ctx: AuthContext, endpoint: string): Promise<void> {
    await this.col.deleteOne({ endpoint, userId: ctx.userId });
  }
}
