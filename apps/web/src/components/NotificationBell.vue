<script setup lang="ts">
/**
 * Notification bell for the app-bar. Shows a badge with the unread count, a menu
 * listing recent notifications, and per-item mark-read + deep-link navigation.
 * Data comes from the notifications store (REST-seeded, WS-incremented), so the
 * bell renders fine even when the socket is down.
 */
import { computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useNotificationsStore } from "@/stores/notifications";
import { usePushNotifications } from "@/composables/usePushNotifications";
import type { Notification, NotificationSeverity } from "@/types/domain";

const store = useNotificationsStore();
const router = useRouter();
const { t } = useI18n();

// Web-push subscribe/unsubscribe, surfaced as a small toggle in the bell menu.
// Only shown when supported (SW + PushManager + VAPID key configured).
const push = usePushNotifications();
onMounted(async () => {
  await push.refresh();
  // First-visit auto-prompt (once per browser; no-op if already decided/asked).
  // If declined, the manual toggle below still works.
  void push.maybeAutoPrompt();
});
const onTogglePush = async (): Promise<void> => {
  if (push.isSubscribed.value) await push.unsubscribe();
  else await push.subscribe();
};

// The bell lists UNREAD notifications only (read ones drop off once acknowledged);
// the full history lives on the notifications page. `unread` drives the badge.
const unreadItems = computed<Notification[]>(() => store.recent.filter((n) => !n.readAt));
const unread = computed<number>(() => store.unreadCount);

const SEVERITY_ICON: Record<NotificationSeverity, string> = {
  info: "mdi-information-outline",
  success: "mdi-check-circle-outline",
  warning: "mdi-alert-outline",
  critical: "mdi-alert-octagon-outline",
};

const SEVERITY_COLOR: Record<NotificationSeverity, string> = {
  info: "info",
  success: "success",
  warning: "warning",
  critical: "error",
};

/** Fallback icon by category when `severity` is absent/unknown (older/seeded
 *  notifications may not carry a severity → without this the icon renders blank). */
const CATEGORY_ICON: Record<string, string> = {
  invoices: "mdi-file-document-outline",
  quotes: "mdi-file-document-edit-outline",
  payments: "mdi-cash",
  expenses: "mdi-cash-multiple",
  contracts: "mdi-file-sign",
  subscriptions: "mdi-autorenew",
  clients: "mdi-account-group-outline",
  system: "mdi-cog-outline",
};

const iconFor = (n: Notification): string => {
  return (n.severity && SEVERITY_ICON[n.severity]) || CATEGORY_ICON[n.category ?? ""] || "mdi-bell-outline";
};
const iconColorFor = (n: Notification): string => {
  return (n.severity && SEVERITY_COLOR[n.severity]) || "primary";
};

const routeFor = (n: Notification): { path: string } | null => {
  if (!n.entityType || !n.entityId) return null;
  const map: Record<string, string> = {
    invoice: "/invoices",
    quote: "/quotes",
    expense: "/expenses",
    contract: "/contracts",
    subscription: "/subscriptions",
    time_entry: "/time-entries",
  };
  const base = map[n.entityType];
  return base ? { path: `${base}/${n.entityId}` } : null;
};

const onSelect = async (n: Notification): Promise<void> => {
  if (!n.readAt) await store.markRead(n.id);
  const target = routeFor(n);
  if (target) await router.push(target);
};

const onMarkAllRead = async (): Promise<void> => {
  await store.markAllRead();
};

const localized = (key: string | null | undefined, params: Record<string, string> | null | undefined, fallback: string): string => {
  if (!key) return fallback;
  const out = t(key, params ?? {});
  return out === key ? fallback : out;
};

const titleFor = (n: Notification): string => {
  return localized(n.titleKey, n.params, n.title);
};

const bodyFor = (n: Notification): string => {
  return localized(n.bodyKey, n.params, n.body);
};
</script>

<template>
  <v-menu location="bottom end" :close-on-content-click="false">
    <template #activator="{ props }">
      <v-btn
        v-bind="props"
        icon
        color="info"
        :aria-label="t('notifications.title') + (unread ? ` (${unread})` : '')"
        :title="t('notifications.title')"
      >
        <v-badge
          :model-value="unread > 0"
          :content="unread > 99 ? '99+' : unread"
          color="error"
        >
          <v-icon icon="mdi-bell-outline" />
        </v-badge>
      </v-btn>
    </template>

    <v-card min-width="340" max-width="420">
      <v-toolbar density="compact" flat>
        <v-toolbar-title class="text-subtitle-1">{{ t("notifications.title") }}</v-toolbar-title>
        <v-spacer />
        <v-btn
          v-if="unread > 0"
          variant="text"
          size="small"
          @click="onMarkAllRead"
        >
          {{ t("notifications.markAllRead") }}
        </v-btn>
      </v-toolbar>
      <v-divider />

      <!-- Web-push toggle (per-device). Only when supported. "denied" is a
           terminal browser state the user must clear in site settings. -->
      <template v-if="push.isSupported">
        <v-list-item density="compact" class="py-2">
          <template #prepend>
            <v-icon
              :icon="push.isSubscribed.value ? 'mdi-bell-ring-outline' : 'mdi-bell-plus-outline'"
              class="mr-3"
            />
          </template>
          <v-list-item-title class="text-body-2">{{ t("notifications.push.label") }}</v-list-item-title>
          <v-list-item-subtitle v-if="push.permission.value === 'denied'">
            {{ t("notifications.push.denied") }}
          </v-list-item-subtitle>
          <template #append>
            <v-switch
              :model-value="push.isSubscribed.value"
              :disabled="push.busy.value || push.permission.value === 'denied'"
              :loading="push.busy.value"
              color="primary"
              density="compact"
              class="ml-2"
              hide-details
              inset
              :aria-label="t('notifications.push.label')"
              @update:model-value="onTogglePush"
            />
          </template>
        </v-list-item>
        <v-divider />
      </template>

      <v-list v-if="unreadItems.length > 0" density="comfortable" lines="two" max-height="420">
        <v-list-item
          v-for="n in unreadItems"
          :key="n.id"
          active
          @click="onSelect(n)"
        >
          <template #prepend>
            <v-icon :icon="iconFor(n)" :color="iconColorFor(n)" />
          </template>
          <v-list-item-title>{{ titleFor(n) }}</v-list-item-title>
          <v-list-item-subtitle>{{ bodyFor(n) }}</v-list-item-subtitle>
          <template #append>
            <v-icon icon="mdi-circle" color="primary" size="10" />
          </template>
        </v-list-item>
      </v-list>

      <div v-else class="pa-8 text-center" style="color: var(--v-billy-text-3)">
        <v-icon icon="mdi-bell-sleep-outline" size="32" class="mb-2" />
        <div class="text-body-2">{{ t("notifications.empty") }}</div>
      </div>
    </v-card>
  </v-menu>
</template>
