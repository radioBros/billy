import { randomUUID } from "node:crypto";
import type { DomainEvent } from "@/platform/service.js";

/**
 * Domain-event → WebSocket-event projection. This is the ONE place the domain→WS mapping lives.
 *
 * WS payloads are MINIMAL (ids + changed fields + status), never full documents
 * — the client refetches detail. Delivery is scoped
 * per-user: an event is routed to exactly one user's room, and if the target
 * user cannot be resolved the event is DROPPED (fail-closed) rather than
 * broadcast — the security-critical "never leak another user's data" property.
 */

/** The wire envelope pushed to clients. */
export interface WsEvent {
  eventId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

/** Name of the socket.io event carrying a {@link WsEvent}. */
export const WS_EVENT_CHANNEL = "event";

export const userRoom = (userId: string): string => {
  return `user:${userId}`;
};

/**
 * The result of projecting a domain event: the wire event plus the single user
 * whose room it targets. `null` means "not projected" — either the event type
 * is not in the WS subset, or its recipient could not be resolved. A `null`
 * result MUST NOT be delivered anywhere (fail-closed).
 */
export interface ProjectedEvent {
  targetUserId: string;
  event: WsEvent;
}

/**
 * The WS event subset this module currently projects.
 *
 * SCOPE: per-user notification events only. `notification.created` /
 * `notification.updated` are owned by a single recipient, so target resolution
 * is unambiguous and needs no per-entity permission lookup.
 *
 * DEFERRED (future — needs authorization-scoped fan-out, not available from this
 * module): invoice/quote/timer/subscription/contract/dashboard.refresh events.
 * Those require per-entity permission
 * resolution to decide the authorized recipient set; until that lands they are
 * NOT projected (and therefore never leaked).
 */
const PROJECTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "notification.created",
  "notification.updated",
]);

export const isProjectable = (eventType: string): boolean => {
  return PROJECTED_EVENT_TYPES.has(eventType);
};

const resolveTargetUserId = (event: DomainEvent): string | null => {
  const candidate = event.payload?.["userId"];
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }
  return null;
};

export const projectEvent = (event: DomainEvent): ProjectedEvent | null => {
  if (!isProjectable(event.name)) return null;
  const targetUserId = resolveTargetUserId(event);
  if (!targetUserId) return null;

  const wsEvent: WsEvent = {
    eventId: randomUUID(),
    eventType: event.name,
    entityType: event.entityType,
    entityId: event.entityId,
    timestamp: new Date().toISOString(),
    // Minimal payload: pass through the event payload as-is. The notifications
    // engine already emits a minimal projection (id + type + unread delta), so
    // no full document is present here.
    payload: event.payload ?? {},
  };

  return { targetUserId, event: wsEvent };
};
