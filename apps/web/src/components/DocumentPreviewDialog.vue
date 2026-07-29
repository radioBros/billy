<script setup lang="ts">
/**
 * DocumentPreviewDialog — a large scrollable dialog that renders a full
 * standalone document (A4 print CSS) returned by a preview-draft endpoint.
 *
 * The HTML is a complete document, so it MUST be isolated from the app's styles:
 * we render it in an `<iframe :srcdoc>` sandbox rather than injecting it inline.
 *
 * v-model controls open/close. We never mutate the `modelValue` prop directly;
 * the inner dialog and the close button emit `update:modelValue`.
 */
import { useI18n } from "vue-i18n";

defineProps<{
  modelValue: boolean;
  html: string | null;
  loading: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
}>();

const { t } = useI18n();
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    max-width="900"
    scrollable
    @update:model-value="emit('update:modelValue', $event)"
  >
    <v-card variant="outlined" rounded="lg">
      <v-card-title class="d-flex align-center">
        {{ t("documents.preview") }}
        <v-spacer />
        <v-btn
          icon="mdi-close"
          variant="text"
          :aria-label="t('common.cancel')"
          @click="emit('update:modelValue', false)"
        />
      </v-card-title>
      <v-card-text style="min-height: 200px">
        <div v-if="loading" class="d-flex justify-center align-center" style="height: 200px">
          <v-progress-circular indeterminate />
        </div>
        <iframe
          v-else-if="html"
          :srcdoc="html"
          style="width: 100%; height: 75vh; border: 0; background: #fff"
        />
      </v-card-text>
    </v-card>
  </v-dialog>
</template>
