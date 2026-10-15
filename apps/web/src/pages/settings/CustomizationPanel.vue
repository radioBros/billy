<script setup lang="ts">
/**
 * Settings Panel. Reachable by every AUTHENTICATED user (route requires auth
 * only). Tabs are gated by the principal's capabilities:
 *   - "User Settings" (password + 2FA) is shown to EVERYONE.
 *   - The customization tabs require `canManageSettings` (admins).
 *   - The "Users" tab requires `canManageUsers`.
 * A shared success snackbar is provided to children via provide/inject so every
 * tab reports saves uniformly.
 */
import { ref, provide, computed, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import BrandingTab from "@/pages/settings/tabs/BrandingTab.vue";
import EmailTab from "@/pages/settings/tabs/EmailTab.vue";
import LocalizationTab from "@/pages/settings/tabs/LocalizationTab.vue";
import DocumentsTab from "@/pages/settings/tabs/DocumentsTab.vue";
import DocumentDesignTab from "@/pages/settings/tabs/DocumentDesignTab.vue";
import EmailContractDesignTab from "@/pages/settings/tabs/EmailContractDesignTab.vue";
import CompanyTab from "@/pages/settings/tabs/CompanyTab.vue";
import EInvoicingTab from "@/pages/settings/tabs/EInvoicingTab.vue";
import AdvancedTab from "@/pages/settings/tabs/AdvancedTab.vue";
import UserSettingsTab from "@/pages/settings/tabs/UserSettingsTab.vue";
import UsersTab from "@/pages/settings/tabs/UsersTab.vue";
import { SNACKBAR_KEY, type NotifyFn } from "@/pages/settings/snackbar";
import { useAuthStore } from "@/stores/auth";
import { useIsMobile } from "@/composables/useIsMobile";
import PageHeader from "@/components/PageHeader.vue";

const { t } = useI18n();
const auth = useAuthStore();

const canManageSettings = computed<boolean>(() => auth.principal?.capabilities.canManageSettings === true);
const canManageUsers = computed<boolean>(() => auth.principal?.capabilities.canManageUsers === true);

const route = useRoute();
const router = useRouter();
const isMobile = useIsMobile();
const isSysadmin = computed<boolean>(() => auth.principal?.isSysadmin === true);

const DEFAULT_TAB = "userSettings";
// Admin customization tabs (gated by canManageSettings) + the always-available user
// tab + the users tab (gated by canManageUsers). Order is display-only.
const ADMIN_TABS = ["branding", "email", "localization", "documents", "design", "emailContractDesign", "company", "einvoicing", "advanced"];

/** The set of tabs the CURRENT principal may open (capability-gated). */
const allowedTabs = computed<string[]>(() => {
  const tabs = [DEFAULT_TAB];
  if (canManageSettings.value) tabs.push(...ADMIN_TABS);
  if (canManageUsers.value) tabs.push("users");
  return tabs;
});

/** Resolve a raw route param to a valid, authorized tab (else the default). */
const resolveTab = (raw: unknown): string => {
  const val = typeof raw === "string" ? raw : "";
  return allowedTabs.value.includes(val) ? val : DEFAULT_TAB;
};

// Everyone lands on their User Settings; the `:tab?` route segment deep-links the
// rest. Init from the URL so a refresh/shared link opens the right tab.
const tab = ref<string>(resolveTab(route.params.tab));

// URL → tab: back/forward or an externally-changed link updates the active tab.
watch(
  () => route.params.tab,
  (raw) => {
    const resolved = resolveTab(raw);
    if (resolved !== tab.value) tab.value = resolved;
  },
);

// tab → URL: clicking a tab reflects into the path (replace, so tab switches don't
// pollute history). The default tab uses the bare path (no trailing segment). The
// existing query (e.g. ?mustChangePassword=1) is preserved.
watch(tab, (next) => {
  // Phones navigate by pushing real routes (list → section), never by the ref.
  if (isMobile.value) return;
  const target = next === DEFAULT_TAB ? undefined : next;
  if ((route.params.tab ?? undefined) !== target) {
    void router.replace({ name: "settings-customization", params: { tab: target }, query: route.query });
  }
});

// If the URL named a tab this principal can't open (or an unknown one), normalise
// the address bar to what actually rendered (keeping any query).
if (resolveTab(route.params.tab) !== (route.params.tab ?? DEFAULT_TAB)) {
  const target = tab.value === DEFAULT_TAB ? undefined : tab.value;
  void router.replace({ name: "settings-customization", params: { tab: target }, query: route.query });
}

const snackbar = ref(false);
const snackbarText = ref("");
const notify: NotifyFn = (text: string) => {
  snackbarText.value = text;
  snackbar.value = true;
};
provide(SNACKBAR_KEY, notify);

// ── Phone: a section LIST that drills into one section (with a back arrow) ──
// The `:tab?` deep link keeps working: the bare path shows the list, a named
// tab opens that section. The User Settings section is addressed explicitly as
// `/settings/customization/userSettings` on phones (the bare path is the list).

interface SectionDef {
  value: string;
  label: string;
  icon: string;
  color: string;
}

/** Same labels/icons/colors as the desktop rail (kept in sync by hand). */
const SECTIONS = computed<Record<string, SectionDef>>(() => ({
  userSettings: { value: "userSettings", label: t("settings.userSettingsTab"), icon: "mdi-account-circle-outline", color: "primary" },
  branding: { value: "branding", label: t("settings.tabs.branding"), icon: "mdi-palette-outline", color: "purple" },
  email: { value: "email", label: t("settings.tabs.email"), icon: "mdi-email-outline", color: "blue" },
  localization: { value: "localization", label: t("settings.tabs.localization"), icon: "mdi-translate", color: "teal" },
  documents: { value: "documents", label: t("settings.tabs.documents"), icon: "mdi-file-document-outline", color: "indigo" },
  design: { value: "design", label: t("settings.documentDesignTab"), icon: "mdi-format-paint", color: "pink" },
  emailContractDesign: { value: "emailContractDesign", label: t("settings.emailContractDesignTab"), icon: "mdi-email-newsletter", color: "cyan" },
  company: { value: "company", label: t("settings.tabs.company"), icon: "mdi-office-building-outline", color: "green" },
  einvoicing: { value: "einvoicing", label: t("settings.einvoicingTab"), icon: "mdi-file-send-outline", color: "red" },
  advanced: { value: "advanced", label: t("settings.tabs.advanced"), icon: "mdi-tune", color: "warning" },
  users: { value: "users", label: t("settings.usersTab"), icon: "mdi-account-group-outline", color: "deep-purple" },
}));

const TAB_COMPONENTS: Record<string, Component> = {
  userSettings: UserSettingsTab,
  branding: BrandingTab,
  email: EmailTab,
  localization: LocalizationTab,
  documents: DocumentsTab,
  design: DocumentDesignTab,
  emailContractDesign: EmailContractDesignTab,
  company: CompanyTab,
  einvoicing: EInvoicingTab,
  advanced: AdvancedTab,
  users: UsersTab,
};

/** Grouped list rows: you → workspace → team. Empty groups are dropped. */
const mobileGroups = computed<SectionDef[][]>(() => {
  const s = SECTIONS.value;
  const groups: SectionDef[][] = [[s.userSettings!]];
  if (canManageSettings.value) groups.push(ADMIN_TABS.map((k) => s[k]!));
  if (canManageUsers.value) groups.push([s.users!]);
  return groups;
});

/** A list only makes sense with more than one section; a forced password change opens it directly. */
const hasMobileList = computed<boolean>(
  () => allowedTabs.value.length > 1 && route.query.mustChangePassword === undefined && auth.principal?.mustChangePassword !== true,
);
const showMobileList = computed<boolean>(() => hasMobileList.value && !route.params.tab);
const mobileTab = computed<string>(() => resolveTab(route.params.tab));
const mobileSection = computed<SectionDef>(() => SECTIONS.value[mobileTab.value] ?? SECTIONS.value[DEFAULT_TAB]!);

const sectionRoute = (value: string) => ({ name: "settings-customization", params: { tab: value } });

/**
 * Back arrow: pop history when we got here from within settings (the list, or a
 * cross-link such as E-invoicing → Company); a cold deep link goes up to the list.
 */
const backToList = (): void => {
  const back = (window.history.state as { back?: unknown } | null)?.back;
  if (typeof back === "string" && back.startsWith("/settings/customization")) {
    router.back();
  } else {
    void router.replace({ name: "settings-customization", params: { tab: undefined } });
  }
};

// Drilling in/out on a phone starts the new screen at the top.
watch(
  () => route.params.tab,
  () => {
    if (isMobile.value) window.scrollTo({ top: 0 });
  },
);
</script>

<template>
  <!-- ── Phone: section list → one section (drill-in with a back arrow) ── -->
  <div v-if="isMobile" class="settings-m">
    <template v-if="showMobileList">
      <PageHeader :title="t('settings.pageTitle')" />
      <nav :aria-label="t('settings.pageTitle')">
        <div v-for="(group, gi) in mobileGroups" :key="gi" class="settings-m__group" role="list">
          <div v-for="s in group" :key="s.value" class="settings-m__item" role="listitem">
            <router-link :to="sectionRoute(s.value)" class="settings-m__row" :data-test="`settings-section-${s.value}`">
              <v-avatar :color="s.color" variant="tonal" rounded="lg" size="36" class="settings-m__icon">
                <v-icon :icon="s.icon" size="20" />
              </v-avatar>
              <span class="settings-m__label">{{ s.label }}</span>
              <v-icon icon="mdi-chevron-right" size="20" class="settings-m__chevron" />
            </router-link>
          </div>
          <div v-if="gi === mobileGroups.length - 1 && isSysadmin" class="settings-m__item" role="listitem">
            <router-link :to="{ name: 'settings-accounts' }" class="settings-m__row" data-test="settings-section-accounts">
              <v-avatar color="blue-grey" variant="tonal" rounded="lg" size="36" class="settings-m__icon">
                <v-icon icon="mdi-office-building-cog-outline" size="20" />
              </v-avatar>
              <span class="settings-m__label">{{ t("nav.accounts") }}</span>
              <v-icon icon="mdi-chevron-right" size="20" class="settings-m__chevron" />
            </router-link>
          </div>
        </div>
      </nav>
    </template>

    <template v-else>
      <div class="settings-m__head">
        <v-btn
          v-if="hasMobileList"
          icon="mdi-arrow-left"
          variant="text"
          class="settings-m__back"
          :aria-label="t('common.back')"
          @click="backToList"
        />
        <h1 class="settings-m__title text-h5">{{ hasMobileList ? mobileSection.label : t("settings.pageTitle") }}</h1>
      </div>
      <component :is="TAB_COMPONENTS[mobileTab]" :key="mobileTab" />
    </template>

    <v-snackbar v-model="snackbar" color="success" :timeout="3000">
      {{ snackbarText }}
    </v-snackbar>
  </div>

  <div v-else>
    <h1 class="text-h5 mb-4">{{ t("settings.pageTitle") }}</h1>

    <!-- Vertical tab rail: every item is visible at once (no horizontal scroll).
         Stacks above the content on narrow screens. -->
    <div class="settings-layout">
      <v-tabs
        v-model="tab"
        direction="vertical"
        color="primary"
        density="comfortable"
        class="settings-rail"
      >
        <v-tab value="userSettings">
          <template #prepend><v-icon icon="mdi-account-circle-outline" color="primary" /></template>
          {{ t("settings.userSettingsTab") }}
        </v-tab>
        <template v-if="canManageSettings">
          <v-tab value="branding">
            <template #prepend><v-icon icon="mdi-palette-outline" color="purple" /></template>
            {{ t("settings.tabs.branding") }}
          </v-tab>
          <v-tab value="email">
            <template #prepend><v-icon icon="mdi-email-outline" color="blue" /></template>
            {{ t("settings.tabs.email") }}
          </v-tab>
          <v-tab value="localization">
            <template #prepend><v-icon icon="mdi-translate" color="teal" /></template>
            {{ t("settings.tabs.localization") }}
          </v-tab>
          <v-tab value="documents">
            <template #prepend><v-icon icon="mdi-file-document-outline" color="indigo" /></template>
            {{ t("settings.tabs.documents") }}
          </v-tab>
          <v-tab value="design">
            <template #prepend><v-icon icon="mdi-format-paint" color="pink" /></template>
            {{ t("settings.documentDesignTab") }}
          </v-tab>
          <v-tab value="emailContractDesign">
            <template #prepend><v-icon icon="mdi-email-newsletter" color="cyan" /></template>
            {{ t("settings.emailContractDesignTab") }}
          </v-tab>
          <v-tab value="company">
            <template #prepend><v-icon icon="mdi-office-building-outline" color="green" /></template>
            {{ t("settings.tabs.company") }}
          </v-tab>
          <v-tab value="einvoicing">
            <template #prepend><v-icon icon="mdi-file-send-outline" color="red" /></template>
            {{ t("settings.einvoicingTab") }}
          </v-tab>
          <v-tab value="advanced">
            <template #prepend><v-icon icon="mdi-tune" color="warning" /></template>
            {{ t("settings.tabs.advanced") }}
          </v-tab>
        </template>
        <v-tab v-if="canManageUsers" value="users">
          <template #prepend><v-icon icon="mdi-account-group-outline" color="deep-purple" /></template>
          {{ t("settings.usersTab") }}
        </v-tab>
      </v-tabs>

      <v-window v-model="tab" class="settings-content">
        <v-window-item value="userSettings" eager>
          <UserSettingsTab />
        </v-window-item>
        <template v-if="canManageSettings">
          <v-window-item value="branding">
            <BrandingTab />
          </v-window-item>
          <v-window-item value="email">
            <EmailTab />
          </v-window-item>
          <v-window-item value="localization">
            <LocalizationTab />
          </v-window-item>
          <v-window-item value="documents">
            <DocumentsTab />
          </v-window-item>
          <v-window-item value="design">
            <DocumentDesignTab />
          </v-window-item>
          <v-window-item value="emailContractDesign">
            <EmailContractDesignTab />
          </v-window-item>
          <v-window-item value="company">
            <CompanyTab />
          </v-window-item>
          <v-window-item value="einvoicing">
            <EInvoicingTab />
          </v-window-item>
          <v-window-item value="advanced">
            <AdvancedTab />
          </v-window-item>
        </template>
        <v-window-item v-if="canManageUsers" value="users">
          <UsersTab />
        </v-window-item>
      </v-window>
    </div>

    <v-snackbar v-model="snackbar" color="success" :timeout="3000">
      {{ snackbarText }}
    </v-snackbar>
  </div>
</template>

<style scoped>
/* Two-column settings layout: a fixed vertical tab rail + flexible content. */
.settings-layout {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}
.settings-rail {
  flex: 0 0 220px;
  width: 220px;
  position: sticky;
  top: 16px;
}
/* Left-align the vertical tab labels + let long labels read normally. */
.settings-rail :deep(.v-tab) {
  justify-content: flex-start;
  text-transform: none;
}
.settings-content {
  flex: 1 1 auto;
  min-width: 0;
}
/* Stack the rail above the content on narrow screens. */
@media (max-width: 800px) {
  .settings-layout {
    flex-direction: column;
  }
  .settings-rail {
    flex-basis: auto;
    width: 100%;
    position: static;
  }
}
</style>

<style scoped>
/* ── Phone: grouped section list (iOS-style) ───────────────────────────── */
.settings-m__group {
  background: rgb(var(--v-theme-surface));
  border: 1px solid var(--v-billy-border, #e2e4e9);
  border-radius: 16px;
  overflow: hidden;
  margin-bottom: 16px;
}
.settings-m__row {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 56px;
  padding: 8px 12px 8px 14px;
  color: rgb(var(--v-theme-on-surface));
  text-decoration: none;
  -webkit-tap-highlight-color: transparent;
  transition: background-color var(--billy-dur-fast, 150ms) ease;
}
.settings-m__row {
  position: relative;
}
/* Inset hairline between rows, aligned with the label (iOS list style). */
.settings-m__item + .settings-m__item .settings-m__row::before {
  content: "";
  position: absolute;
  top: 0;
  left: 64px;
  right: 0;
  height: 1px;
  background: var(--v-billy-border, #e2e4e9);
}
.settings-m__row:active {
  background: rgba(var(--v-theme-primary), 0.06);
}
.settings-m__row:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: -2px;
}
.settings-m__label {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 1rem;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.settings-m__chevron {
  flex: 0 0 auto;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.45));
}

/* ── Phone: section title row (matches PageHeader's phone variant) ─────── */
.settings-m__head {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 44px;
  margin-bottom: 12px;
}
.settings-m__back {
  margin-left: -8px;
}
.settings-m__title {
  min-width: 0;
  font-size: 1.375rem !important;
  line-height: 1.25;
  font-weight: 700;
  letter-spacing: -0.02em !important;
  overflow-wrap: anywhere;
}
</style>

<style>
/* ── Phone: shared look for every settings section (unscoped, prefixed) ──
 * Each tab's outer card becomes a 16px panel; tabs that tag their outer card
 * `.settings-bare` (sectioned / stepped tabs) drop it entirely so their own
 * section cards — and FormSteps' sticky head/bar — sit directly on the page. */
.settings-m .v-card--variant-outlined {
  border-radius: 16px !important;
}
/* A form grid's negative row margin otherwise pulls the first field's
 * floating label up against the card edge. */
.settings-m .v-card--variant-outlined:not(.settings-bare) > .v-card-text {
  padding-top: 22px !important;
}
.settings-m .settings-bare {
  background: transparent !important;
  border: 0 !important;
  border-radius: 0 !important;
  overflow: visible !important;
}
.settings-m .settings-bare > .v-card-text {
  padding: 0 !important;
}
/* Phone panel card: the design-language card for a block of fields. */
.settings-m .settings-m-card {
  background: rgb(var(--v-theme-surface));
  border: 1px solid var(--v-billy-border, #e2e4e9);
  border-radius: 16px;
  padding: 20px 16px 16px;
  margin-bottom: 12px;
}
.settings-m .v-expansion-panels:not(.oa-notice) > .v-expansion-panel {
  border-radius: 16px !important;
  border: 1px solid var(--v-billy-border, #e2e4e9);
}
.settings-m .v-expansion-panels:not(.oa-notice) > .v-expansion-panel::after {
  display: none;
}
</style>
