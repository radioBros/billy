import type { BaseDoc } from "@billy/types";

/**
 * Notifications module types.
 *
 * SCOPE: the **in-app channel** only. A Notification is the
 * per-user, in-app read model the notification center renders
 * and the engine's `createFromEvent` entry point produces. Push and email
 * channels (defaultChannels.push / .email) are DEFERRED.
 *
 * A Notification is a **projection of a domain event**:
 * one vocabulary delivered across channels; this file models the in-app row.
 */

/**
 * Notification category (the plural values are authoritative). Each
 * per-category channel toggle in NotificationPreferences keys off these.
 */
export type NotificationCategory =
  | "invoices"
  | "quotes"
  | "recurring_billing"
  | "time_tracking"
  | "expenses"
  | "contracts"
  | "subscriptions"
  | "system";

export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  "invoices",
  "quotes",
  "recurring_billing",
  "time_tracking",
  "expenses",
  "contracts",
  "subscriptions",
  "system",
] as const;

/** Severity → channel defaults. */
export type NotificationSeverity = "info" | "success" | "warning" | "critical";

/**
 * In-app notification (one per (user, event) delivery). `userId` is the OWNER —
 * per-user isolation is enforced by scoping every repository query to it
 * (repository.ts), NOT via BaseRepository's `scopeField` (that binds to
 * `accountId`, not the user). `readAt` null = unread.
 */
export interface Notification extends BaseDoc {
  /** Owning user. A user only ever sees their own notifications. */
  userId: string;
  /** Category, derived from the event when created. */
  category: NotificationCategory;
  /** The domain-event name that produced this notification (e.g. `invoice.paid`). */
  type: string;
  severity: NotificationSeverity;
  /** English-rendered fallback (always present, non-breaking for old clients). */
  title: string;
  body: string;
  /**
   * i18n render keys. When set, the client renders
   * `t(titleKey, params)` / `t(bodyKey, params)` in the user's locale and only
   * falls back to `title`/`body` if the key is missing. Stored so a locale
   * switch retranslates existing notifications.
   */
  titleKey?: string | null;
  bodyKey?: string | null;
  params?: Record<string, string> | null;
  /** Deep-link target ("open related record"). */
  entityType?: string | null;
  entityId?: string | null;
  /** null = unread; ISO timestamp = read. */
  readAt?: string | null;
  /** Free-form projection of the event payload (kept minimal). */
  metadata?: Record<string, unknown> | null;
}

/** Per-category in-app channel toggle. `inApp` is the only live channel currently. */
export interface CategoryChannelToggle {
  /** In-app delivery on/off. Absent/undefined → treated as ON (default). */
  inApp: boolean;
  // `push` toggle — Web Push channel deferred.
  // `email` toggle — email channel deferred.
}

/**
 * Per-user notification preferences (version-tracked overlay). One document per
 * user; `categories` overlays the seed-table defaults. An absent category →
 * inApp defaults ON.
 *
 * NOTE: the exhaustive per-EVENT preference matrix (generated from the seed
 * table) is deferred; this models the per-CATEGORY in-app toggle the
 * create-from-event entry point resolves against.
 */
export interface NotificationPreferences extends BaseDoc {
  /** Owning user (also the isolation scope). */
  userId: string;
  categories: Partial<Record<NotificationCategory, CategoryChannelToggle>>;
}

// The exhaustive eventType → category / severity / channel-defaults seed table
//   (`packages/shared/notification-events.seed.ts`) is not yet present. This
//   derives category from the event-name prefix (service.ts) and applies
//   severity defaults inline until the seed lands.
// `NotificationDelivery` (per-channel pending→sent→delivered→read→failed) is a
//   separate store for the push/email channels — not modelled here.
