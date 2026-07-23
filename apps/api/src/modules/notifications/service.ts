import type { AuthContext, Capabilities, ListMeta } from "@billy/types";
import type { Logger } from "@billy/shared";
import type { DomainEvent, DomainEventEmitter } from "@/platform/service.js";
import type {
  NotificationPreferencesRepository,
  NotificationRepository,
} from "@/modules/notifications/repository.js";
import { NOTIFICATION_LIST_WHITELIST, type PreferencesUpdateInput } from "@/modules/notifications/schema.js";
import {
  NOTIFICATION_CATEGORIES,
  type Notification,
  type NotificationCategory,
  type NotificationPreferences,
  type NotificationSeverity,
} from "@/modules/notifications/types.js";

/**
 * Notifications business logic. All logic lives here, never in controllers.
 * Owns:
 *  - `createFromEvent` — the engine entry point an integrator wires domain
 *    events into. Resolves per-user preferences and creates in-app Notification
 *    docs, respecting the per-category `inApp` toggle.
 *  - the caller-facing read model: list (unread-first), unreadCount, markRead,
 *    markAllRead.
 *  - preference get / patch.
 *
 * Per-user isolation: read-side methods use the caller's real ctx (scoped to
 * ctx.userId in the repository). createFromEvent writes for RECIPIENTS, not the
 * event actor, so it synthesizes a minimal system ctx per recipient — insert
 * stamps `userId = ctx.userId = recipient`, so the owner is always the recipient.
 *
 * DEFERRED (this is the IN-APP channel only):
 *  - Web Push channel.
 *  - Email channel.
 *  - Quiet-hours + privacy-mode substitution.
 *  - Per-channel NotificationDelivery store + WS `notification.created/updated`
 *    push (realtime).
 */
/** Minimal enqueue port (the QueueRegistry satisfies it) — optional so tests +
 *  queue-less contexts skip push. Structural to avoid a hard dep on the queue. */
export interface NotificationPushQueue {
  enqueue(
    queue: "notifications",
    payload: { userId: string; eventType: string; entityId: string; accountId: string },
    opts?: { idempotencyParts?: readonly string[] },
  ): Promise<unknown>;
}

export interface NotificationServiceDeps {
  repo: NotificationRepository;
  prefsRepo: NotificationPreferencesRepository;
  emitter: DomainEventEmitter;
  logger: Logger;
  /** When present, each created notification also enqueues a web-push job. */
  pushQueue?: NotificationPushQueue;
}

/** A system principal holds no interactive capabilities. */
const SYSTEM_CAPABILITIES: Capabilities = {
  canManageSettings: false,
  canManageUsers: false,
  canPermanentlyDelete: false,
  canViewFinancialTotals: false,
  canExportData: false,
};

/**
 * Map a domain-event name prefix → notification category. Event names are
 * singular-prefixed (`invoice.paid`); categories are plural.
 * Unmapped prefixes (client.*, auth.*, …) fall
 * back to `system`. The exhaustive eventType→category seed is engine-owned —
 * this is the interim derivation.
 */
const PREFIX_TO_CATEGORY: Readonly<Record<string, NotificationCategory>> = {
  invoice: "invoices",
  quote: "quotes",
  recurring: "recurring_billing",
  time: "time_tracking",
  expense: "expenses",
  contract: "contracts",
  subscription: "subscriptions",
  system: "system",
};

export const categoryForEvent = (eventType: string): NotificationCategory => {
  const prefix = eventType.split(".")[0] ?? "";
  return PREFIX_TO_CATEGORY[prefix] ?? "system";
};

const severityForEvent = (eventType: string): NotificationSeverity => {
  if (eventType.startsWith("system.") && /fail|unavailable/u.test(eventType)) return "warning";
  return "info";
};

export class NotificationService {
  private readonly repo: NotificationRepository;
  private readonly prefsRepo: NotificationPreferencesRepository;
  private readonly emitter: DomainEventEmitter;
  private readonly logger: Logger;
  private readonly pushQueue?: NotificationPushQueue;

  constructor(deps: NotificationServiceDeps) {
    this.repo = deps.repo;
    this.prefsRepo = deps.prefsRepo;
    this.emitter = deps.emitter;
    this.logger = deps.logger;
    this.pushQueue = deps.pushQueue;
  }

  // ── Engine entry point ─────────────────────────────────────────────────────

  /**
   * Entry point the integrator wires domain events into.
   * For each recipient: resolve preferences, and if the category's
   * in-app channel is enabled (default ON), create one owned in-app Notification.
   *
   * Returns the created notifications (one per recipient whose in-app toggle is
   * on). Push/email fan-out for the same event is DEFERRED.
   */
  async createFromEvent(event: DomainEvent, recipients: string[], accountId: string): Promise<Notification[]> {
    const category = categoryForEvent(event.name);
    const severity = severityForEvent(event.name);
    const created: Notification[] = [];

    for (const recipient of recipients) {
      const ctx = this.systemCtxFor(recipient, accountId);
      const prefs = await this.prefsRepo.findForUser(ctx);
      if (!this.inAppEnabled(prefs, category)) {
        this.logger.info(
          { userId: recipient, category, event: event.name },
          "notification.suppressed_inapp_off",
        );
        continue;
      }
      const keys = this.renderKeys(event);
      const doc = await this.repo.insert(ctx, {
        category,
        type: event.name,
        severity,
        title: this.titleFor(event), // English fallback (always stored)
        body: this.bodyFor(event),
        titleKey: keys.titleKey, // client renders t(titleKey, params) in the user's locale
        bodyKey: keys.bodyKey,
        params: keys.params,
        entityType: event.entityType,
        entityId: event.entityId,
        readAt: null,
        metadata: event.payload ?? null,
      });
      created.push(doc);
      // Emit `notification.created` so the realtime WS server can push to the
      // recipient's sockets. The realtime projection keys off `payload.userId` =
      // the RECIPIENT (doc.userId), so it can route to the right user's connections.
      // `actorId: null` = system projection (mirrors public-links' system emissions).
      await this.emit({
        name: "notification.created",
        actorId: null,
        entityType: "notification",
        entityId: doc.id,
        payload: { userId: recipient },
      });
      // Web-push fan-out: enqueue one job per recipient. The worker
      // re-reads the notification doc (title/body) and sends to that user's push
      // subscriptions. Fire-and-forget: a queue failure must never break in-app
      // creation, so it's swallowed with a warn. Skipped when no queue is wired
      // (tests / queue-less contexts) via the optional dep.
      if (this.pushQueue) {
        void this.pushQueue
          .enqueue(
            "notifications",
            {
              userId: recipient,
              eventType: event.name,
              entityId: doc.id,
              accountId: ctx.accountId,
            },
            // One push per (recipient, notification) — dedupes retries/double-emits.
            { idempotencyParts: [recipient, doc.id] },
          )
          .catch((err: unknown) => {
            this.logger.warn({ err, userId: recipient, event: event.name }, "notification.push_enqueue_failed");
          });
      }
    }
    return created;
  }

  // ── Caller-facing read model ───────────────────────────────────────────────

  /** List the caller's own notifications, unread-first. */
  async list(
    ctx: AuthContext,
    rawQuery: Record<string, string | string[] | undefined>,
  ): Promise<{ items: Notification[]; meta: ListMeta }> {
    const { items, parsed, total } = await this.repo.list(ctx, rawQuery, NOTIFICATION_LIST_WHITELIST);
    const meta: ListMeta = {
      page: parsed.page,
      limit: parsed.limit,
      total,
      pageCount: Math.max(1, Math.ceil(total / parsed.limit)),
      sort: parsed.sortSpec,
      ...(parsed.q ? { q: parsed.q } : {}),
    };
    return { items, meta };
  }

  /** Unread count for the caller. */
  async unreadCount(ctx: AuthContext): Promise<number> {
    return this.repo.countUnread(ctx);
  }

  /** Mark one of the caller's notifications read (idempotent). Null if not owned. */
  async markRead(ctx: AuthContext, id: string): Promise<Notification | null> {
    const updated = await this.repo.markRead(ctx, id);
    if (updated) {
      // Mirror `notification.created` on the read state-change so realtime can
      // decrement the recipient's unread badge. `payload.userId` = the owner
      // (updated.userId, which equals ctx.userId here — a user only reads their own).
      await this.emit({
        name: "notification.updated",
        actorId: ctx.userId,
        entityType: "notification",
        entityId: updated.id,
        payload: { userId: updated.userId },
      });
    }
    return updated;
  }

  /** Mark all the caller's notifications read. Returns the count updated. */
  async markAllRead(ctx: AuthContext): Promise<number> {
    return this.repo.markAllRead(ctx);
  }

  // ── Preferences ────────────────────────────────────────────────────────────

  /**
   * The caller's preferences. If none exist, returns a synthesized default doc
   * where every category has in-app ON (the default).
   */
  async getPreferences(ctx: AuthContext): Promise<NotificationPreferences> {
    const existing = await this.prefsRepo.findForUser(ctx);
    if (existing) return existing;
    const ts = new Date().toISOString();
    return {
      id: "",
      userId: ctx.userId,
      categories: Object.fromEntries(
        NOTIFICATION_CATEGORIES.map((c) => [c, { inApp: true }]),
      ) as NotificationPreferences["categories"],
      version: 0,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      deletedAt: null,
    };
  }

  /** Merge a category-toggle patch into the caller's preferences (upsert). */
  async updatePreferences(
    ctx: AuthContext,
    input: PreferencesUpdateInput,
  ): Promise<NotificationPreferences> {
    return this.prefsRepo.upsertForUser(
      ctx,
      input.categories as NotificationPreferences["categories"],
    );
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * System ctx so createFromEvent can insert for a recipient (owner = recipient).
   * MUST carry the recipient's real `accountId`: the fail-closed BaseRepository
   * stamps it on insert, and the recipient later reads filtered by their own
   * account — a wrong/synthetic accountId here silently hides the notification.
   */
  private systemCtxFor(recipient: string, accountId: string): AuthContext {
    return {
      userId: recipient,
      role: "member",
      capabilities: SYSTEM_CAPABILITIES,
      accountId,
    };
  }

  /** In-app enabled when no prefs doc, or the category toggle is absent, or explicitly true. */
  private inAppEnabled(
    prefs: NotificationPreferences | null,
    category: NotificationCategory,
  ): boolean {
    const toggle = prefs?.categories?.[category];
    return toggle?.inApp ?? true;
  }

  /**
   * i18n render keys for a notification. The client renders
   * `t(titleKey, params)` / `t(bodyKey, params)` in the user's locale, falling
   * back to the stored English `title`/`body` only if a key is missing. Keys
   * follow `notification.event.<event.name>.title|body`; a per-event catalog on
   * the frontend translates them (with a `notification.event.generic.*` fallback).
   */
  private renderKeys(event: DomainEvent): { titleKey: string; bodyKey: string; params: Record<string, string> } {
    const entity = `${event.entityType ?? ""} ${event.entityId ?? ""}`.trim();
    const params = { entity, entityType: event.entityType ?? "", entityId: event.entityId ?? "" };
    // Prefer an event-specific key; the FE resolves a missing one to the generic
    // fallback (t() miss → returns the key → FE guard shows generic/English).
    return {
      titleKey: `notification.event.${event.name}.title`,
      bodyKey: `notification.event.${event.name}.body`,
      params,
    };
  }

  /** English fallback title (always stored; used when a titleKey is missing on the client). */
  private titleFor(event: DomainEvent): string {
    return event.name.replace(/\./g, " ").replace(/_/g, " ").replace(/\b\w/gu, (c) => c.toUpperCase());
  }

  private bodyFor(event: DomainEvent): string {
    return `${event.entityType ?? ""} ${event.entityId ?? ""}`.trim();
  }

  /** Kept for symmetry with the emitter dependency (WS emission is deferred). */
  protected async emit(event: DomainEvent): Promise<void> {
    await this.emitter.emit(event);
  }
}
