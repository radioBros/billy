/** Notifications module barrel (notifications_orchestrator). In-app channel slice. */
export { createNotificationsRouter } from "@/modules/notifications/routes.js";
export {
  NOTIFICATIONS_COLLECTION,
  PREFERENCES_COLLECTION,
  NotificationRepository,
  NotificationPreferencesRepository,
} from "@/modules/notifications/repository.js";
export { NotificationService, categoryForEvent } from "@/modules/notifications/service.js";
export {
  PreferencesUpdateSchema,
  NOTIFICATION_LIST_WHITELIST,
  type PreferencesUpdateInput,
} from "@/modules/notifications/schema.js";
export {
  NOTIFICATION_CATEGORIES,
  type Notification,
  type NotificationCategory,
  type NotificationSeverity,
  type NotificationPreferences,
  type CategoryChannelToggle,
} from "@/modules/notifications/types.js";
