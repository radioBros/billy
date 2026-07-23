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
