/**
 * Notifications store (notification-center). Holds the caller's in-app
 * notifications + unread count. Deliberately SOCKET-AGNOSTIC: it is seeded from
 * the REST endpoint and mutated either by explicit user actions (markRead) or by
 * `ingest(evt)` calls made by `useRealtime` when a WS event arrives. This keeps
 * the store unit-testable without a socket (call `ingest` directly).
 *
 * REST endpoints (apps/api notifications/routes.ts):
 *   GET  /api/v1/notifications              — list (unread-first)
 *   GET  /api/v1/notifications/unread-count — { count }
 *   POST /api/v1/notifications/:id/read     — mark one read (returns updated)
 *   POST /api/v1/notifications/read-all     — mark all read
 *
 * WS mapping (apps/api realtime/projection.ts): the server pushes a MINIMAL
 * `WsEvent` on the `"event"` channel with `eventType` ∈
 * {notification.created, notification.updated}. `entityId` is the notification id.
 * Because the payload is minimal (never a full document), `ingest` refetches the
 * list + unread count rather than trusting the payload to be a Notification.
 */
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { api, ApiError } from "@/api/client";
import type { Notification, WsEvent } from "@/types/domain";

// ── Display text (pure — unit-testable without mounting the bell) ────────────

/** Translate fn shape (vue-i18n `t`); a miss returns the key itself. */
export type NotificationTranslate = (key: string, params?: Record<string, string>) => string;

/** Existing catalog keys naming each entity type (singular), by emitted entityType. */
const ENTITY_TYPE_KEYS: Readonly<Record<string, string>> = {
  invoice: "invoices.detailTitle",
  quote: "quotes.detailTitle",
  proforma: "proformas.detailTitle",
  creditNote: "creditNotes.detailTitle",
  contract: "contracts.detailTitle",
  recurring_profile: "recurring.detailTitle",
  client: "clients.selector.label",
  expense: "enums.recurringDocType.expense",
};

const RAW_ID = /^[0-9a-f]{24}$/iu;
/** Legacy `params.entity` / `body` shape: "<entityType> <24-hex id>". */
const RAW_ENTITY_REF = /^[\w-]+\s+[0-9a-f]{24}$/iu;

/**
 * True when a stored label/body is just a raw entity reference (old
 * notifications stored `params.entity = "invoice 6a5e57c2…"`) — never display it.
 */
export const isRawEntityRef = (value: string | null | undefined, entityId?: string | null): boolean => {
  const v = (value ?? "").trim();
  if (!v) return false;
  if (RAW_ID.test(v) || RAW_ENTITY_REF.test(v)) return true;
  return !!entityId && v.includes(entityId);
};

const tr = (t: NotificationTranslate, key: string | null | undefined, params?: Record<string, string>): string | null => {
  if (!key) return null;
  const out = t(key, params);
  return out && out !== key ? out : null;
};

/** Collapse the gap an empty `{entity}` leaves ("Invoice  was paid" → "Invoice was paid"). */
const tidy = (text: string): string => {
  return text.replace(/\s{2,}/gu, " ").replace(/\s+([,.;:!?])/gu, "$1").trim();
};

/** Translated singular entity-type name ("Invoice" / "Fattura"); humanized when unknown. */
export const entityTypeLabel = (t: NotificationTranslate, entityType: string | null | undefined): string => {
  const type = entityType ?? "";
  if (!type) return "";
  const own = tr(t, `notification.entityType.${type}`) ?? tr(t, ENTITY_TYPE_KEYS[type]);
  if (own) return own;
  const words = type.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[_-]+/gu, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Human entity label for `{entity}`: "" for legacy raw ids, translated "Draft" for drafts. */
export const notificationEntity = (t: NotificationTranslate, n: Notification): string => {
  const p = n.params ?? {};
  if (p.entityDraft === "1") return tr(t, "enums.status.draft") ?? p.entity ?? "";
  const entity = p.entity ?? "";
  return isRawEntityRef(entity, n.entityId ?? p.entityId) ? "" : entity;
};

const paramsFor = (t: NotificationTranslate, n: Notification): Record<string, string> => {
  return { ...(n.params ?? {}), entity: notificationEntity(t, n) };
};

/** Localized title: event key → stored English (if not a raw ref) → generic. */
export const notificationTitle = (t: NotificationTranslate, n: Notification): string => {
  const out = tr(t, n.titleKey, paramsFor(t, n));
  if (out) return tidy(out);
  if (n.title && !isRawEntityRef(n.title, n.entityId)) return n.title;
  return tr(t, "notification.event.generic.title") ?? "";
};

/**
 * Localized body. Never shows a raw id: legacy `"invoice <hex>"` labels are
 * dropped (the sentence reads "Invoice was paid in full"), and a raw stored
 * body falls back to the generic text with the translated entity type.
 */
export const notificationBody = (t: NotificationTranslate, n: Notification): string => {
  const params = paramsFor(t, n);
  const out = tr(t, n.bodyKey, params);
  if (out) return tidy(out);
  if (n.body && !isRawEntityRef(n.body, n.entityId)) return n.body;
  const entity = params.entity || entityTypeLabel(t, n.entityType ?? n.params?.entityType);
  if (!entity) return "";
  return tidy(tr(t, "notification.event.generic.body", { ...params, entity }) ?? entity);
};

/** Newest-first list length cap held in memory for the bell menu. */
const MAX_ITEMS = 50;

interface UnreadCountResponse {
  count: number;
}

export const useNotificationsStore = defineStore("notifications", () => {
  const items = ref<Notification[]>([]);
  const unreadCount = ref<number>(0);
  const loading = ref<boolean>(false);
  /** True once a seed attempt has completed (success or handled failure). */
  const seeded = ref<boolean>(false);

  const hasUnread = computed<boolean>(() => unreadCount.value > 0);
  const recent = computed<Notification[]>(() => items.value.slice(0, 10));

  function recomputeUnread(): void {
    unreadCount.value = items.value.filter((n) => !n.readAt).length;
  }

  /**
   * Seed the list + unread count from REST. Never throws: on failure it leaves
   * the current (possibly empty) state so the bell degrades gracefully — the WS
   * being down does not depend on this, and this being down does not crash the
   * shell. Idempotent; safe to call on every (re)authentication.
   */
  async function seed(): Promise<void> {
    loading.value = true;
    try {
      const result = await api.list<Notification>("/v1/notifications", { limit: MAX_ITEMS });
      items.value = result.data;
      // Prefer the authoritative unread-count endpoint; fall back to a local count.
      try {
        const { count } = await api.get<UnreadCountResponse>("/v1/notifications/unread-count");
        unreadCount.value = typeof count === "number" ? count : 0;
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        recomputeUnread();
      }
    } catch (err) {
      // Keep existing state; surface nothing. Non-ApiError (unexpected) rethrows.
      if (!(err instanceof ApiError)) throw err;
    } finally {
      seeded.value = true;
      loading.value = false;
    }
  }

  /**
   * Handle an incoming WS event. Only notification events matter; anything else
   * is ignored. Because the WS payload is minimal, we resync from REST (cheap:
   * the list is small and the server is authoritative for unread-first order and
   * the exact unread count).
   */
  function ingest(evt: WsEvent): void {
    if (evt.eventType !== "notification.created" && evt.eventType !== "notification.updated") {
      return;
    }
    void seed();
  }

  /** Mark one notification read (idempotent). Optimistically updates, then syncs. */
  async function markRead(id: string): Promise<void> {
    const existing = items.value.find((n) => n.id === id);
    if (existing && !existing.readAt) {
      existing.readAt = new Date().toISOString();
      recomputeUnread();
    }
    try {
      const updated = await api.post<Notification>(`/v1/notifications/${id}/read`);
      const idx = items.value.findIndex((n) => n.id === id);
      if (idx !== -1 && updated) items.value.splice(idx, 1, updated);
      recomputeUnread();
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      // Roll back the optimistic flip on failure.
      if (existing) {
        existing.readAt = null;
        recomputeUnread();
      }
    }
  }

  /** Mark all read. */
  async function markAllRead(): Promise<void> {
    try {
      await api.post<{ updated: number }>("/v1/notifications/read-all");
      const now = new Date().toISOString();
      for (const n of items.value) if (!n.readAt) n.readAt = now;
      unreadCount.value = 0;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
    }
  }

  /** Reset to empty (called on logout). */
  function clear(): void {
    items.value = [];
    unreadCount.value = 0;
    seeded.value = false;
  }

  return {
    items,
    unreadCount,
    loading,
    seeded,
    hasUnread,
    recent,
    seed,
    ingest,
    markRead,
    markAllRead,
    clear,
  };
});
