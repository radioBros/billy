<script setup lang="ts">
/**
 * ConfirmDialog — the single host for `useConfirm`. Mounted ONCE (AppShell), it
 * binds the shared singleton state and renders a flat, light-grey-bordered
 * v-dialog. The confirm button colour follows `tone`. Resolving happens via
 * `resolveConfirm` so the awaiting caller gets its boolean.
 */
import { useI18n } from "vue-i18n";
import { confirmState, resolveConfirm } from "@/composables/useConfirm";

const { t } = useI18n();

const onConfirm = (): void => {
  resolveConfirm(true);
};
const onCancel = (): void => {
  resolveConfirm(false);
};
</script>

<template>
  <v-dialog
    :model-value="confirmState.open"
    max-width="440"
    persistent
    @update:model-value="(v: boolean) => { if (!v) onCancel(); }"
  >
    <v-card variant="outlined" rounded="lg">
      <v-card-title>{{ confirmState.title }}</v-card-title>
      <v-card-text class="text-body-2" style="white-space: pre-line">
        {{ confirmState.message }}
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="onCancel">
          {{ confirmState.cancelText ?? t("common.cancel") }}
        </v-btn>
        <v-btn
          :color="confirmState.tone"
          variant="flat"
          @click="onConfirm"
        >
          {{ confirmState.confirmText ?? t("common.confirm") }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
