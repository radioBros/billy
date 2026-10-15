<script setup lang="ts">
/**
 * DocumentActions — Preview / Print / Download for one document, reused across
 * the invoice/quote/credit-note detail pages (and, via the shared composable,
 * the table row menus). Flat theme: outlined buttons, no shadow.
 *
 *  - Preview: fetches the rendered HTML and shows it in a sandboxed <iframe>
 *    (srcdoc). A Print button inside the dialog calls contentWindow.print().
 *  - Print (top-level): opens the preview, then prints once the iframe loads.
 *  - Download: GETs the /pdf endpoint; polls while pending, then anchor-clicks
 *    the ready downloadUrl.
 *
 * The heavy lifting lives in useDocumentActions so RowActionMenu can reuse it.
 *
 * Phone (< 600px): the three actions become a full-width row of equal tonal
 * tiles (icon over label), and the preview opens fullscreen with the A4 sheet
 * rendered at its real width and scaled down to fit the screen (the document
 * never reflows into a cramped 360px column).
 */
import { ref, toRef, computed, watch, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { useDocumentActions, type DocumentType } from "@/composables/useDocumentActions";
import { actionIconColor } from "@/constants/iconColors";
import { useIsMobile } from "@/composables/useIsMobile";

const props = withDefaults(
  defineProps<{
    documentType: DocumentType;
    documentId: string;
    disabled?: boolean;
  }>(),
  { disabled: false },
);

const { t } = useI18n();
const isMobile = useIsMobile();

const typeRef = toRef(props, "documentType");
const idRef = toRef(props, "documentId");

const {
  previewOpen,
  previewHtml,
  previewLoading,
  downloading,
  errorMessage,
  openPreview,
  download,
} = useDocumentActions(
  () => typeRef.value,
  () => idRef.value,
);

const iframeRef = ref<HTMLIFrameElement | null>(null);
// When true, print the iframe as soon as its content finishes loading (top-level Print).
const printOnLoad = ref(false);

const printIframe = (): void => {
  const win = iframeRef.value?.contentWindow;
  if (!win) return;
  // Focus the iframe before printing — several browsers print a BLANK page (or
  // the parent) when print() is called on a srcdoc iframe that isn't focused.
  win.focus();
  win.print();
};

const onPrint = async (): Promise<void> => {
  printOnLoad.value = true;
  await openPreview();
};

// ── Phone fit-to-width preview ──────────────────────────────────────────────
// The iframe is laid out at the A4 width (210mm ≈ 794 CSS px) and scaled down to
// the available width; its height follows the document so the dialog scrolls
// (never a nested scroller inside a transformed iframe).
const PAGE_W = 794;
const PAGE_H = 1123;
const fitRef = ref<HTMLElement | null>(null);
const fitWidth = ref(0);
const contentHeight = ref(PAGE_H);
const fitScale = computed<number>(() => (fitWidth.value > 0 ? Math.min(1, fitWidth.value / PAGE_W) : 1));
let fitObserver: ResizeObserver | null = null;
watch(fitRef, (el) => {
  fitObserver?.disconnect();
  fitObserver = null;
  if (!el || typeof ResizeObserver === "undefined") return;
  // Usable width = the box minus its 12px side padding and the sheet's 1px border.
  const measure = (): void => {
    fitWidth.value = Math.max(0, el.clientWidth - 26);
  };
  fitObserver = new ResizeObserver(measure);
  fitObserver.observe(el);
  measure();
});
onBeforeUnmount(() => fitObserver?.disconnect());

const measureContent = (): void => {
  const doc = iframeRef.value?.contentDocument;
  const h = doc?.documentElement?.scrollHeight ?? 0;
  contentHeight.value = Math.max(PAGE_H, h);
};

const onIframeLoad = (): void => {
  if (isMobile.value) measureContent();
  if (printOnLoad.value) {
    printOnLoad.value = false;
    // Wait a paint tick so the srcdoc content is laid out before printing
    // (printing at the raw load event can capture a blank page).
    requestAnimationFrame(() => requestAnimationFrame(printIframe));
  }
};
</script>

<template>
  <div :class="isMobile ? 'doc-actions--mobile' : 'd-inline-flex align-center'" :style="isMobile ? undefined : 'gap: 8px'">
    <!-- Phone: three equal tiles (icon over label) spanning the row. -->
    <template v-if="isMobile">
      <v-btn
        v-for="a in [
          { key: 'preview', icon: 'mdi-eye-outline', color: 'info', label: t('documentActions.preview'), run: openPreview, loading: false },
          { key: 'print', icon: 'mdi-printer-outline', color: 'info', label: t('documentActions.print'), run: onPrint, loading: false },
          { key: 'download', icon: 'mdi-download-outline', color: 'success', label: t('documentActions.download'), run: download, loading: downloading },
        ]"
        :key="a.key"
        :color="a.color"
        variant="tonal"
        class="doc-actions__tile"
        :disabled="disabled"
        :loading="a.loading"
        :aria-label="a.label"
        :data-test="`doc-action-${a.key}`"
        @click="a.run"
      >
        <v-icon :icon="a.icon" size="22" />
        <span class="doc-actions__tile-label">{{ a.label }}</span>
      </v-btn>
    </template>
    <template v-else>
    <v-btn
      color="info"
      :disabled="disabled"
      @click="openPreview"
    >
      <template #prepend>
        <v-icon icon="mdi-eye-outline" :color="actionIconColor('preview')" />
      </template>
      {{ t("documentActions.preview") }}
    </v-btn>
    <v-btn
      color="info"
      :disabled="disabled"
      @click="onPrint"
    >
      <template #prepend>
        <v-icon icon="mdi-printer-outline" :color="actionIconColor('print')" />
      </template>
      {{ t("documentActions.print") }}
    </v-btn>
    <v-btn
      color="success"
      :disabled="disabled"
      :loading="downloading"
      @click="download"
    >
      <template #prepend>
        <v-icon icon="mdi-download-outline" :color="actionIconColor('download')" />
      </template>
      {{ t("documentActions.download") }}
    </v-btn>
    </template>

    <v-snackbar :model-value="errorMessage !== null" color="error" :timeout="4000" @update:model-value="errorMessage = null">
      {{ t("documentActions.error", { code: errorMessage }) }}
    </v-snackbar>

    <v-dialog v-model="previewOpen" max-width="900" scrollable :fullscreen="isMobile">
      <v-card variant="outlined" :rounded="isMobile ? 0 : 'lg'" class="doc-actions__preview-card">
        <v-card-title class="d-flex align-center" :class="{ 'doc-actions__preview-bar': isMobile }">
          <span class="text-truncate">{{ t("documentActions.previewTitle") }}</span>
          <v-spacer />
          <v-btn
            color="info"
            size="small"
            :disabled="previewLoading"
            @click="printIframe"
          >
            <template #prepend>
              <v-icon icon="mdi-printer-outline" :color="actionIconColor('print')" />
            </template>
            {{ t("documentActions.print") }}
          </v-btn>
          <v-btn icon="mdi-close" variant="text" size="small" :aria-label="t('common.cancel')" @click="previewOpen = false" />
        </v-card-title>
        <v-divider />
        <v-card-text class="pa-0 doc-actions__preview-body" :class="{ 'doc-actions__preview-body--mobile': isMobile }">
          <div v-if="previewLoading" class="pa-8 text-center">
            <v-progress-circular indeterminate />
          </div>
          <!-- Phone: the sheet keeps its A4 layout width and is scaled to fit. -->
          <div v-else-if="isMobile" ref="fitRef" class="doc-actions__fit">
            <div
              class="doc-actions__fit-sheet"
              :style="{ width: `${PAGE_W * fitScale}px`, height: `${contentHeight * fitScale}px` }"
            >
              <iframe
                ref="iframeRef"
                :srcdoc="previewHtml"
                class="doc-actions__fit-iframe"
                :style="{ width: `${PAGE_W}px`, height: `${contentHeight}px`, transform: `scale(${fitScale})` }"
                sandbox="allow-same-origin allow-modals"
                scrolling="no"
                :title="t('documentActions.previewTitle')"
                @load="onIframeLoad"
              />
            </div>
          </div>
          <!-- A grey backdrop with padding so the white A4 "page" floats with a
               margin inside the dialog (mirrors a real document viewer). The
               @page print margin only applies when printed, so on-screen we frame
               the page ourselves. -->
          <div v-else class="doc-actions__page-wrap">
            <iframe
              ref="iframeRef"
              :srcdoc="previewHtml"
              class="doc-actions__iframe"
              sandbox="allow-same-origin allow-modals"
              :title="t('documentActions.previewTitle')"
              @load="onIframeLoad"
            />
          </div>
        </v-card-text>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
/* Grey viewer backdrop; the page floats inside with padding + scrolls if tall. */
.doc-actions__preview-body {
  height: 78vh;
  background: #eceef1;
  overflow: auto;
}
/* Centering + breathing room around the A4 sheet. */
.doc-actions__page-wrap {
  display: flex;
  justify-content: center;
  padding: 24px;
  min-height: 100%;
}
/* The white "sheet": A4 portrait proportions (210:297), capped width, its own
   inner padding mirroring the print @page margin (~16mm) so on-screen content
   isn't flush to the edges. A thin border reads as the page edge (flat theme). */
.doc-actions__iframe {
  width: 100%;
  max-width: 720px;
  aspect-ratio: 210 / 297;
  height: auto;
  border: 1px solid var(--v-billy-border, #e2e4e9);
  background: #fff;
  /* Inner padding lives inside the iframe document via injected CSS (see
     useDocumentActions); the sheet itself only frames it. */
}

/* ── Phone ─────────────────────────────────────────────────────────────── */
.doc-actions--mobile {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  width: 100%;
}
.doc-actions__tile {
  height: 60px !important;
  min-width: 0 !important;
  padding: 0 6px !important;
  border-radius: 14px !important;
  letter-spacing: 0;
  text-transform: none;
}
.doc-actions__tile :deep(.v-btn__content) {
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
}
.doc-actions__tile-label {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.75rem;
  font-weight: 600;
}
.doc-actions__preview-bar {
  min-height: 56px;
  padding: 6px 8px 6px 16px !important;
  gap: 8px;
}
.doc-actions__preview-body--mobile {
  height: auto;
  flex: 1 1 auto;
}
.doc-actions__fit {
  padding: 12px;
  min-height: 100%;
}
/* Holds the scaled sheet's real footprint (transform doesn't affect layout). */
.doc-actions__fit-sheet {
  position: relative;
  overflow: hidden;
  margin: 0 auto;
  background: #fff;
  border: 1px solid var(--v-billy-border, #e2e4e9);
  box-sizing: content-box;
}
.doc-actions__fit-iframe {
  display: block;
  border: 0;
  background: #fff;
  transform-origin: top left;
}
</style>
