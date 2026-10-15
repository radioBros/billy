import type { AuthContext, Capabilities, ListMeta } from "@billy/types";
import type { Logger } from "@billy/shared";
import type { DomainEvent, DomainEventEmitter } from "@/platform/service.js";
import type {
  NotificationPreferencesRepository,
  NotificationRepository,
} from "@/modules/notifications/repository.js";
import { NOTIFICATION_LIST_WHITELIST, type PreferencesUpdateInput } from "@/modules/notifications/schema.js";
import type { EntityLabel, EntityLabelResolver } from "@/modules/notifications/entity-labels.js";
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
  /**
   * Resolves a human label for the event's entity (document number, client
   * name, …) within the account. Optional: without it (tests, minimal
   * contexts) the label is empty — the raw entity id is NEVER shown instead.
   */
  entityLabels?: EntityLabelResolver;
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

/**
 * English fallback text per curated event (mirrors the web `notification.event.*`
 * catalog). `body` carries `{entity}`; `bare` is used when the label is unknown so
 * the sentence still reads naturally ("Invoice was paid in full").
 */
const EN_TEXT: Readonly<Record<string, { title: string; body: string; bare: string }>> = {
  "invoice.finalized": { title: "Invoice finalized", body: "Invoice {entity} was finalized", bare: "An invoice was finalized" },
  "invoice.paid": { title: "Invoice paid", body: "Invoice {entity} was paid in full", bare: "An invoice was paid in full" },
  "invoice.void": { title: "Invoice voided", body: "Invoice {entity} was voided", bare: "An invoice was voided" },
  "invoice.scheduled": { title: "Invoice scheduled", body: "Invoice {entity} was scheduled to be finalized", bare: "An invoice was scheduled to be finalized" },
  "quote.sent": { title: "Quote sent", body: "Quote {entity} was sent", bare: "A quote was sent" },
  "quote.accepted": { title: "Quote accepted", body: "Quote {entity} was accepted", bare: "A quote was accepted" },
  "quote.declined": { title: "Quote declined", body: "Quote {entity} was declined", bare: "A quote was declined" },
  "quote.converted": { title: "Quote converted", body: "Quote {entity} was converted to an invoice", bare: "A quote was converted to an invoice" },
  "payment.received": { title: "Payment received", body: "A payment was received for {entity}", bare: "A payment was received" },
  "contract.renewed": { title: "Contract renewed", body: "Contract {entity} was renewed", bare: "A contract was renewed" },
  "recurring.occurrence_generated": {
    title: "Recurring document generated",
    body: "A new document was generated from the recurring profile {entity}",
    bare: "A new document was generated from a recurring profile",
  },
};

/** "time.entry_created" → "Time entry created" (sentence case, for unmapped events). */
const humanizeEventName = (name: string): string => {
  const words = name.replace(/[._]+/gu, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** English title/body for the stored fallback — human text only, never an id. */
export const englishText = (event: DomainEvent, label: string): { title: string; body: string } => {
  const known = EN_TEXT[event.name];
  if (known) return { title: known.title, body: label ? known.body.replace("{entity}", label) : known.bare };
  const title = humanizeEventName(event.name);
  return { title, body: label ? `${title}: ${label}` : title };
};

export class NotificationService {
  private readonly repo: NotificationRepository;
  private readonly prefsRepo: NotificationPreferencesRepository;
  private readonly emitter: DomainEventEmitter;
  private readonly logger: Logger;
  private readonly pushQueue?: NotificationPushQueue;
  private readonly entityLabels?: EntityLabelResolver;

  constructor(deps: NotificationServiceDeps) {
    this.repo = deps.repo;
    this.prefsRepo = deps.prefsRepo;
    this.emitter = deps.emitter;
    this.logger = deps.logger;
    this.pushQueue = deps.pushQueue;
    this.entityLabels = deps.entityLabels;
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
    // One label lookup per event (not per recipient) — all share the account.
    const entity = await this.resolveEntityLabel(event, accountId);
    const keys = this.renderKeys(event, entity);
    const text = englishText(event, entity.label);

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
      const doc = await this.repo.insert(ctx, {
        category,
        type: event.name,
        severity,
        title: text.title, // English fallback (always stored; also the web-push text)
        body: text.body,
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

  /** Human label for the event's entity; empty (never the raw id) when unknown. */
  private async resolveEntityLabel(event: DomainEvent, accountId: string): Promise<EntityLabel> {
    if (!this.entityLabels || !event.entityType || !event.entityId) return { label: "" };
    try {
      return await this.entityLabels.labelFor(accountId, event.entityType, event.entityId);
    } catch (err) {
      // A label is cosmetic — a lookup failure must never drop the notification.
      this.logger.warn({ err, event: event.name }, "notification.entity_label_failed");
      return { label: "" };
    }
  }

  /**
   * i18n render keys for a notification. The client renders
   * `t(titleKey, params)` / `t(bodyKey, params)` in the user's locale, falling
   * back to the stored English `title`/`body` only if a key is missing. Keys
   * follow `notification.event.<event.name>.title|body`; a per-event catalog on
   * the frontend translates them (with a `notification.event.generic.*` fallback).
   * `params.entity` is the HUMAN label (number / name, "" when unknown);
   * `entityType`/`entityId` stay for deep-linking. `entityDraft: "1"` flags an
   * unnumbered document so the client can translate "Draft".
   */
  private renderKeys(
    event: DomainEvent,
    entity: EntityLabel,
  ): { titleKey: string; bodyKey: string; params: Record<string, string> } {
    const params: Record<string, string> = {
      entity: entity.label,
      entityType: event.entityType ?? "",
      entityId: event.entityId ?? "",
    };
    if (entity.draft) params.entityDraft = "1";
    // Prefer an event-specific key; the FE resolves a missing one to the generic
    // fallback (t() miss → returns the key → FE guard shows generic/English).
    return {
      titleKey: `notification.event.${event.name}.title`,
      bodyKey: `notification.event.${event.name}.body`,
      params,
    };
  }

  /** Kept for symmetry with the emitter dependency (WS emission is deferred). */
  protected async emit(event: DomainEvent): Promise<void> {
    await this.emitter.emit(event);
  }
}
