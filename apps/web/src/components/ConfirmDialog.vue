<script setup lang="ts">
/**
 * ConfirmDialog — the single host for `useConfirm`. Mounted ONCE (AppShell), it
 * binds the shared singleton state and renders a flat, light-grey-bordered
 * v-dialog. The confirm button colour follows `tone`. Resolving happens via
 * `resolveConfirm` so the awaiting caller gets its boolean.
 */
import { useI18n } from "vue-i18n";
import { confirmState, resolveConfirm } from "@/composables/useConfirm";
import { useIsMobile } from "@/composables/useIsMobile";

const { t } = useI18n();
// Phones: the global rules turn the dialog into a bottom sheet; here the title
// loses its grey band and the confirm action gets a solid, thumb-sized button.
const isMobile = useIsMobile();

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
    <v-card variant="outlined" rounded="lg" :class="{ 'confirm--mobile': isMobile }">
      <v-card-title>{{ confirmState.title }}</v-card-title>
      <v-card-text class="text-body-2" style="white-space: pre-line">
        {{ confirmState.message }}
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" :size="isMobile ? 'large' : undefined" @click="onCancel">
          {{ confirmState.cancelText ?? t("common.cancel") }}
        </v-btn>
        <v-btn
          :color="confirmState.tone"
          :variant="isMobile ? 'flat' : undefined"
          :size="isMobile ? 'large' : undefined"
          @click="onConfirm"
        >
          {{ confirmState.confirmText ?? t("common.confirm") }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.confirm--mobile > .v-card-title {
  background-color: transparent !important;
  min-height: 0 !important;
  padding: 20px 20px 4px;
  font-size: 1.125rem;
  font-weight: 700;
  white-space: normal;
}
.confirm--mobile > .v-card-text {
  padding: 4px 20px 16px;
  font-size: 0.9375rem !important;
  color: var(--v-billy-text-2);
}
.confirm--mobile > .v-card-actions {
  border-top: 0 !important;
  padding: 8px 16px 16px !important;
}
</style>
