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
import { ref, provide, computed } from "vue";
import { useI18n } from "vue-i18n";
import BrandingTab from "@/pages/settings/tabs/BrandingTab.vue";
import EmailTab from "@/pages/settings/tabs/EmailTab.vue";
import LocalizationTab from "@/pages/settings/tabs/LocalizationTab.vue";
import DocumentsTab from "@/pages/settings/tabs/DocumentsTab.vue";
import DocumentDesignTab from "@/pages/settings/tabs/DocumentDesignTab.vue";
import EmailContractDesignTab from "@/pages/settings/tabs/EmailContractDesignTab.vue";
import CompanyTab from "@/pages/settings/tabs/CompanyTab.vue";
import AdvancedTab from "@/pages/settings/tabs/AdvancedTab.vue";
import UserSettingsTab from "@/pages/settings/tabs/UserSettingsTab.vue";
import UsersTab from "@/pages/settings/tabs/UsersTab.vue";
import { SNACKBAR_KEY, type NotifyFn } from "@/pages/settings/snackbar";
import { useAuthStore } from "@/stores/auth";

const { t } = useI18n();
const auth = useAuthStore();

const canManageSettings = computed<boolean>(() => auth.principal?.capabilities.canManageSettings === true);
const canManageUsers = computed<boolean>(() => auth.principal?.capabilities.canManageUsers === true);

// Everyone lands on their User Settings; admins can switch to the admin tabs.
const tab = ref<string>("userSettings");

const snackbar = ref(false);
const snackbarText = ref("");
const notify: NotifyFn = (text: string) => {
  snackbarText.value = text;
  snackbar.value = true;
};
provide(SNACKBAR_KEY, notify);
</script>

<template>
  <div>
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
            Branding
          </v-tab>
          <v-tab value="email">
            <template #prepend><v-icon icon="mdi-email-outline" color="blue" /></template>
            Email
          </v-tab>
          <v-tab value="localization">
            <template #prepend><v-icon icon="mdi-translate" color="teal" /></template>
            Localization
          </v-tab>
          <v-tab value="documents">
            <template #prepend><v-icon icon="mdi-file-document-outline" color="indigo" /></template>
            Documents
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
            Company
          </v-tab>
          <v-tab value="advanced">
            <template #prepend><v-icon icon="mdi-tune" color="warning" /></template>
            Advanced
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
