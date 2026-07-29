<script setup lang="ts">
/**
 * App-bar account switcher. Sysadmin-only: lists all accounts, highlights the
 * currently-assumed one (principal.accountId), and assumes the selected account
 * (which hard-reloads the app under the new scope). Hidden for normal users.
 */
import { computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useAuthStore } from "@/stores/auth";
import { useAccountStore } from "@/stores/account";
import { useToast } from "@/composables/useToast";

const auth = useAuthStore();
const accountStore = useAccountStore();
const { toast } = useToast();
const { t } = useI18n();

const isSysadmin = computed<boolean>(() => auth.principal?.isSysadmin === true);
const currentId = computed<string | undefined>(() => auth.principal?.accountId);

/** Name of the currently-assumed account; falls back to a generic label. */
const currentName = computed<string>(() => {
  const match = accountStore.accounts.find((a) => a.id === currentId.value);
  return match?.name ?? t("account.label");
});

onMounted(() => {
  if (isSysadmin.value) void accountStore.fetchAccounts();
});

const select = async (accountId: string): Promise<void> => {
  if (accountId === currentId.value) return;
  try {
    await accountStore.assumeAccount(accountId);
  } catch {
    toast.error(t("account.switchError"));
  }
};
</script>

<template>
  <v-menu v-if="isSysadmin" location="bottom end">
    <template #activator="{ props }">
      <!-- Labelled on ≥sm; icon-only on mobile so the top bar doesn't overflow. -->
      <v-btn
        v-bind="props"
        variant="text"
        color="deep-purple"
        prepend-icon="mdi-domain"
        class="d-none d-sm-inline-flex"
        :aria-label="t('account.switch')"
        :title="t('account.switch')"
      >
        {{ currentName }}
      </v-btn>
      <v-btn
        v-bind="props"
        icon
        color="deep-purple"
        class="d-inline-flex d-sm-none"
        :aria-label="t('account.switch')"
        :title="`${t('account.switch')} — ${currentName}`"
      >
        <v-icon icon="mdi-domain" />
      </v-btn>
    </template>
    <v-list density="compact" min-width="220" max-height="420">
      <v-list-subheader>{{ t("account.switch") }}</v-list-subheader>
      <v-list-item
        v-for="acc in accountStore.accounts"
        :key="acc.id"
        :active="acc.id === currentId"
        :title="acc.name"
        :subtitle="acc.slug"
        @click="select(acc.id)"
      >
        <template v-if="acc.id === currentId" #append>
          <v-icon icon="mdi-check" size="18" />
        </template>
      </v-list-item>
    </v-list>
  </v-menu>
</template>
