<script setup lang="ts">
/**
 * BankAccountsEditor — an editable list of named bank accounts bound to
 * business.bankAccounts via defineModel. Each row is a label input + a details
 * textarea (freeform multiline); rows can be added and removed. New rows get a
 * client-side id (the backend keeps whatever id it receives). Flat theme:
 * light-grey-bordered rows, no shadow.
 */
import { useI18n } from "vue-i18n";
import type { BankAccount } from "@/types/domain";

const model = defineModel<BankAccount[]>({ required: true });

const { t } = useI18n();

const newId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `bank_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

const addAccount = (): void => {
  model.value = [...model.value, { id: newId(), label: "", details: "" }];
};

const removeAccount = (index: number): void => {
  model.value = model.value.filter((_, i) => i !== index);
};

const updateLabel = (index: number, value: string): void => {
  model.value = model.value.map((a, i) => (i === index ? { ...a, label: value } : a));
};

const updateDetails = (index: number, value: string): void => {
  model.value = model.value.map((a, i) => (i === index ? { ...a, details: value } : a));
};
</script>

<template>
  <div>
    <div
      v-for="(account, i) in model"
      :key="account.id"
      class="bank-accounts__row pa-3 mb-3"
    >
      <div class="d-flex align-center" style="gap: 12px">
        <v-text-field
          :model-value="account.label"
          :label="t('settings.bankAccounts.label')"
          density="comfortable"
          hide-details
          class="flex-grow-1"
          @update:model-value="(v: string) => updateLabel(i, v)"
        />
        <v-btn
          icon="mdi-delete-outline"
          variant="text"
          size="small"
          color="error"
          :aria-label="t('settings.bankAccounts.remove')"
          @click="removeAccount(i)"
        />
      </div>
      <v-textarea
        :model-value="account.details"
        :label="t('settings.bankAccounts.details')"
        rows="3"
        auto-grow
        density="comfortable"
        hide-details
        class="mt-2"
        @update:model-value="(v: string) => updateDetails(i, v)"
      />
    </div>

    <div v-if="model.length === 0" class="text-caption text-medium-emphasis mb-3">
      {{ t("settings.bankAccounts.empty") }}
    </div>

    <v-btn variant="outlined" prepend-icon="mdi-plus" @click="addAccount">
      {{ t("settings.bankAccounts.add") }}
    </v-btn>
  </div>
</template>

<style scoped>
.bank-accounts__row {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity, 0.24));
  border-radius: 8px;
}
</style>
