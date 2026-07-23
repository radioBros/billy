<script setup lang="ts">
/**
 * App shell: one left sidebar (≤2 levels) + one compact top toolbar +
 * a <main> landmark. Theme toggle in the toolbar. Keyboard + landmark
 * a11y. Modules mount their pages into <router-view>.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useRouter } from "vue-router";
import { useTheme } from "vuetify";
import { useI18n } from "vue-i18n";
import { useThemeStore } from "@/stores/theme";
import { useAuthStore } from "@/stores/auth";
import { useBrandingStore } from "@/stores/branding";
import { useRealtimeStore } from "@/stores/realtime";
import { useSettingsStore } from "@/stores/settings";
import { logoUrlFor } from "@/api/files";
import NotificationBell from "@/components/NotificationBell.vue";
import GlobalYearSelect from "@/components/GlobalYearSelect.vue";
import AccountSwitcher from "@/components/AccountSwitcher.vue";
import LocaleSwitcher from "@/components/LocaleSwitcher.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import ToastHost from "@/components/ToastHost.vue";
import TimerOverlay from "@/components/TimerOverlay.vue";
import PwaPrompts from "@/components/PwaPrompts.vue";
import { usePwaInstall } from "@/composables/usePwaInstall";
import { navIconColor } from "@/constants/iconColors";

const router = useRouter();
const themeStore = useThemeStore();
const auth = useAuthStore();
const branding = useBrandingStore();
const realtime = useRealtimeStore();
const settings = useSettingsStore();
const vuetifyTheme = useTheme();
const pwaInstall = usePwaInstall();
const { t } = useI18n();

const drawer = ref(true);

interface NavItem {
  /** i18n key under `nav.*`. */
  titleKey: string;
  icon: string;
  to: string;
}

/** A top-level nav entry: either a direct link or a group with children (one
 *  level of nesting — the "Documents" dropdown groups the doc types). */
interface NavGroup {
  titleKey: string;
  icon: string;
  /** Present → renders as an expandable group; absent → a direct link (`to`). */
  children?: NavItem[];
  to?: string;
}

const navGroups: NavGroup[] = [
  { titleKey: "nav.dashboard", icon: "mdi-view-dashboard-outline", to: "/" },
  { titleKey: "nav.clients", icon: "mdi-account-group-outline", to: "/clients" },
  { titleKey: "nav.projects", icon: "mdi-folder-multiple-outline", to: "/projects" },
  {
    titleKey: "nav.documents",
    icon: "mdi-file-document-multiple-outline",
    children: [
      { titleKey: "nav.invoices", icon: "mdi-file-document-outline", to: "/invoices" },
      { titleKey: "nav.proforma", icon: "mdi-file-document-check-outline", to: "/proformas" },
      { titleKey: "nav.quotes", icon: "mdi-file-document-edit-outline", to: "/quotes" },
      { titleKey: "nav.creditNotes", icon: "mdi-file-document-minus-outline", to: "/credit-notes" },
      { titleKey: "nav.recurring", icon: "mdi-autorenew", to: "/recurring-profiles" },
    ],
  },
  { titleKey: "nav.expenses", icon: "mdi-cash-multiple", to: "/expenses" },
  { titleKey: "nav.contracts", icon: "mdi-file-sign", to: "/contracts" },
  { titleKey: "nav.timeEntries", icon: "mdi-clock-outline", to: "/time-entries" },
  { titleKey: "nav.subscriptions", icon: "mdi-refresh", to: "/subscriptions" },
];

// Realtime lifecycle (WS notification bell): open the single socket when the
// session is authenticated, close it (and clear notifications) on logout. The
// singleton guard in the store makes login/logout churn safe.
const syncRealtime = (authed: boolean): void => {
  if (authed) realtime.connect();
  else realtime.disconnect();
};
onMounted(() => syncRealtime(auth.isAuthenticated));
watch(() => auth.isAuthenticated, (authed) => syncRealtime(authed));
onBeforeUnmount(() => realtime.disconnect());

// Per-user UI preferences (mandated ServerTable column prefs): load once when
// authenticated, clear on logout so prefs never leak across sessions. Same
// authed-lifecycle pattern as realtime above.
const syncSettings = (authed: boolean): void => {
  if (authed) void settings.load();
  else settings.reset();
};
onMounted(() => syncSettings(auth.isAuthenticated));
watch(() => auth.isAuthenticated, (authed) => syncSettings(authed));

/** Admin-only nav; the route is also capability-guarded (defence in depth). */
const canManageSettings = computed<boolean>(
  () => auth.principal?.capabilities.canManageSettings === true,
);

/** Sysadmin-only nav (accounts management). Route + endpoints are also guarded. */
const isSysadmin = computed<boolean>(() => auth.principal?.isSysadmin === true);

const appName = computed<string>(() => branding.appName);
const logoSrc = computed<string | null>(() =>
  branding.logoFileId ? logoUrlFor(branding.logoFileId) : null,
);
// The brand mark shown in the shell + app bar: an operator-uploaded logo takes
// precedence (white-label), otherwise the bundled horizontal billy logo.
const brandLogoSrc = computed<string>(() => logoSrc.value ?? "/billy.png");


const themeIcon = computed<string>(() => {
  if (themeStore.mode === "system") return "mdi-theme-light-dark";
  return themeStore.mode === "dark" ? "mdi-weather-night" : "mdi-weather-sunny";
});

const themeLabel = computed<string>(() => t("shell.theme", { mode: themeStore.mode }));

const toggleTheme = (): void => {
  themeStore.cycle();
  vuetifyTheme.change(themeStore.vuetifyTheme);
};

const onLogout = async (): Promise<void> => {
  await auth.logout();
  await router.push({ name: "login" });
};
</script>

<template>
  <v-app>
    <v-navigation-drawer v-model="drawer" :width="200" :aria-label="t('shell.primaryNav')" tag="nav">
      <!-- Brand: the horizontal billy logo (icon + wordmark). No separate app-name
           text — the wordmark is part of the image. Falls back to a custom
           uploaded logo (branding.logoFileId) if the operator set one. -->
      <div class="d-flex align-center px-4 py-2 sidebar-top">
        <v-img
          :src="brandLogoSrc"
          :alt="`${appName} logo`"
          :max-height="34"
          :max-width="150"
          contain
          position="left center"
        />
      </div>
      <v-divider />
      <v-list nav density="comfortable">
        <template v-for="group in navGroups">
          <!-- Group with children → expandable (e.g. Documents). -->
          <v-list-group v-if="group.children" :key="`g-${group.titleKey}`" :value="group.titleKey">
            <template #activator="{ props: activatorProps }">
              <v-list-item v-bind="activatorProps" :title="t(group.titleKey)">
                <template #prepend>
                  <v-icon :icon="group.icon" :color="navIconColor(group.titleKey)" />
                </template>
              </v-list-item>
            </template>
            <v-list-item
              v-for="child in group.children"
              :key="child.to"
              :to="child.to"
              :title="t(child.titleKey)"
              exact
            >
              <template #prepend>
                <v-icon :icon="child.icon" :color="navIconColor(child.titleKey)" />
              </template>
            </v-list-item>
          </v-list-group>
          <!-- Direct link. -->
          <v-list-item
            v-else
            :key="`i-${group.titleKey}`"
            :to="group.to"
            :title="t(group.titleKey)"
            exact
          >
            <template #prepend>
              <v-icon :icon="group.icon" :color="navIconColor(group.titleKey)" />
            </template>
          </v-list-item>
        </template>
        <template v-if="canManageSettings">
          <v-divider class="my-2" />
          <v-list-item
            to="/settings/customization"
            :title="t('nav.settings')"
          >
            <template #prepend>
              <v-icon icon="mdi-cog-outline" :color="navIconColor('nav.settings')" />
            </template>
          </v-list-item>
        </template>
        <!-- Accounts management — sysadmin only. -->
        <v-list-item
          v-if="isSysadmin"
          to="/settings/accounts"
          :title="t('nav.accounts')"
        >
          <template #prepend>
            <v-icon icon="mdi-office-building-cog-outline" :color="navIconColor('nav.accounts')" />
          </template>
        </v-list-item>
      </v-list>
    </v-navigation-drawer>

    <v-app-bar flat density="comfortable" tag="header">
      <v-app-bar-nav-icon
        color="primary"
        :aria-label="drawer ? t('shell.collapseNav') : t('shell.expandNav')"
        @click="drawer = !drawer"
      />
      <!--
      <span v-if="route.meta.title" class="text-medium-emphasis text-body-2 ml-4 d-none d-sm-flex">
        {{ pageTitle }}
      </span>
      -->
      <v-spacer />
      <!-- Install the PWA (only when the browser offers it; the address-bar icon
           works independently). -->
      <v-btn
        v-if="pwaInstall.canInstall.value"
        variant="text"
        color="teal"
        prepend-icon="mdi-download-circle-outline"
        :title="t('pwa.install.action')"
        @click="pwaInstall.promptInstall"
      >
        {{ t("pwa.install.action") }}
      </v-btn>
      <GlobalYearSelect v-if="auth.isAuthenticated" />
      <NotificationBell v-if="auth.isAuthenticated" />
      <AccountSwitcher />
      <LocaleSwitcher />
      <v-btn
        icon
        color="amber"
        :aria-label="themeLabel"
        :title="themeLabel"
        @click="toggleTheme"
      >
        <v-icon :icon="themeIcon" />
      </v-btn>
      <!-- Sign out: full label on ≥sm; icon-only on mobile so it never overflows
           off-screen (the label was getting pushed out on narrow widths). -->
      <v-btn
        v-if="auth.isAuthenticated"
        variant="text"
        color="error"
        prepend-icon="mdi-logout"
        class="d-none d-sm-inline-flex"
        @click="onLogout"
      >
        {{ t("shell.signOut") }}
      </v-btn>
      <v-btn
        v-if="auth.isAuthenticated"
        icon
        color="error"
        class="d-inline-flex d-sm-none"
        :aria-label="t('shell.signOut')"
        :title="t('shell.signOut')"
        @click="onLogout"
      >
        <v-icon icon="mdi-logout" />
      </v-btn>
    </v-app-bar>

    <v-main>
      <main aria-label="Main content">
        <v-container fluid class="pa-6">
          <!-- Light fade/slide between pages. `billy-fade` is defined in
               styles/app.css and neutralised under prefers-reduced-motion. The
               route path keys the transition so navigations re-trigger it. -->
          <router-view v-slot="{ Component, route: r }">
            <transition name="billy-fade" mode="out-in">
              <component :is="Component" :key="r.path" />
            </transition>
          </router-view>
        </v-container>
      </main>
    </v-main>

    <!-- App-wide confirmation host for useConfirm(). Mounted once. -->
    <ConfirmDialog />

    <!-- App-wide transient-message host for useToast(). Mounted once. -->
    <ToastHost />

    <!-- PWA install + update prompts (built app only; no-op on the dev server). -->
    <PwaPrompts />

    <!-- App-wide live time-entry timer overlay (mounted once; floats over all
         routes and survives navigation via the pinia timer store). -->
    <TimerOverlay />
  </v-app>
</template>
