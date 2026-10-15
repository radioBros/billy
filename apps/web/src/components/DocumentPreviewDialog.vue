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
 *
 * Phone (< 600px): fullscreen, and the document is laid out at its A4 width and
 * scaled down to fit the screen (fit-to-width) instead of reflowing.
 */
import { ref, computed, watch, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { useIsMobile } from "@/composables/useIsMobile";

defineProps<{
  modelValue: boolean;
  html: string | null;
  loading: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
}>();

const { t } = useI18n();
const isMobile = useIsMobile();

// ── Phone fit-to-width (A4 = 210mm ≈ 794 CSS px wide) ───────────────────────
const PAGE_W = 794;
const PAGE_H = 1123;
const iframeRef = ref<HTMLIFrameElement | null>(null);
const fitRef = ref<HTMLElement | null>(null);
const fitWidth = ref(0);
const contentHeight = ref(PAGE_H);
const fitScale = computed<number>(() => (fitWidth.value > 0 ? Math.min(1, fitWidth.value / PAGE_W) : 1));
let fitObserver: ResizeObserver | null = null;
watch(fitRef, (el) => {
  fitObserver?.disconnect();
  fitObserver = null;
  if (!el || typeof ResizeObserver === "undefined") return;
  // Usable width = the box minus its 12px side padding and the sheet's 1px border
  // + 10px inner margin (this draft HTML carries no on-screen page margin).
  const measure = (): void => {
    fitWidth.value = Math.max(0, el.clientWidth - 46);
  };
  fitObserver = new ResizeObserver(measure);
  fitObserver.observe(el);
  measure();
});
onBeforeUnmount(() => fitObserver?.disconnect());

const onFitLoad = (): void => {
  const h = iframeRef.value?.contentDocument?.documentElement?.scrollHeight ?? 0;
  contentHeight.value = Math.max(PAGE_H, h);
};
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    max-width="900"
    scrollable
    :fullscreen="isMobile"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <v-card variant="outlined" :rounded="isMobile ? 0 : 'lg'">
      <v-card-title class="d-flex align-center" :class="{ 'doc-preview__bar': isMobile }">
        {{ t("documents.preview") }}
        <v-spacer />
        <v-btn
          icon="mdi-close"
          variant="text"
          :aria-label="t('common.cancel')"
          @click="emit('update:modelValue', false)"
        />
      </v-card-title>
      <v-card-text v-if="isMobile" class="pa-0 doc-preview__body">
        <div v-if="loading" class="d-flex justify-center align-center" style="height: 200px">
          <v-progress-circular indeterminate />
        </div>
        <div v-else-if="html" ref="fitRef" class="doc-preview__fit">
          <div
            class="doc-preview__sheet"
            :style="{ width: `${PAGE_W * fitScale}px`, height: `${contentHeight * fitScale}px` }"
          >
            <iframe
              ref="iframeRef"
              :srcdoc="html"
              class="doc-preview__iframe"
              :style="{ width: `${PAGE_W}px`, height: `${contentHeight}px`, transform: `scale(${fitScale})` }"
              sandbox="allow-same-origin allow-modals"
              scrolling="no"
              :title="t('documents.preview')"
              @load="onFitLoad"
            />
          </div>
        </div>
      </v-card-text>
      <v-card-text v-else style="min-height: 200px">
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

<style scoped>
/* ── Phone ─────────────────────────────────────────────────────────────── */
.doc-preview__bar {
  min-height: 56px;
  padding: 6px 8px 6px 16px !important;
}
.doc-preview__body {
  flex: 1 1 auto;
  background: #eceef1;
}
.doc-preview__fit {
  padding: 12px;
  min-height: 100%;
}
/* Holds the scaled sheet's real footprint (transform doesn't affect layout). */
.doc-preview__sheet {
  position: relative;
  overflow: hidden;
  margin: 0 auto;
  background: #fff;
  border: 1px solid var(--v-billy-border, #e2e4e9);
  box-sizing: content-box;
  padding: 10px;
}
.doc-preview__iframe {
  position: absolute;
  top: 10px;
  left: 10px;
  display: block;
  border: 0;
  background: #fff;
  transform-origin: top left;
}
</style>
