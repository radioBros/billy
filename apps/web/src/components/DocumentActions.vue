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
 */
import { ref, toRef } from "vue";
import { useI18n } from "vue-i18n";
import { useDocumentActions, type DocumentType } from "@/composables/useDocumentActions";
import { actionIconColor } from "@/constants/iconColors";

const props = withDefaults(
  defineProps<{
    documentType: DocumentType;
    documentId: string;
    disabled?: boolean;
  }>(),
  { disabled: false },
);

const { t } = useI18n();

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

const onIframeLoad = (): void => {
  if (printOnLoad.value) {
    printOnLoad.value = false;
    // Wait a paint tick so the srcdoc content is laid out before printing
    // (printing at the raw load event can capture a blank page).
    requestAnimationFrame(() => requestAnimationFrame(printIframe));
  }
};
</script>

<template>
  <div class="d-inline-flex align-center" style="gap: 8px">
    <v-btn
      variant="outlined"
      :disabled="disabled"
      @click="openPreview"
    >
      <template #prepend>
        <v-icon icon="mdi-eye-outline" :color="actionIconColor('preview')" />
      </template>
      {{ t("documentActions.preview") }}
    </v-btn>
    <v-btn
      variant="outlined"
      :disabled="disabled"
      @click="onPrint"
    >
      <template #prepend>
        <v-icon icon="mdi-printer-outline" :color="actionIconColor('print')" />
      </template>
      {{ t("documentActions.print") }}
    </v-btn>
    <v-btn
      variant="outlined"
      :disabled="disabled"
      :loading="downloading"
      @click="download"
    >
      <template #prepend>
        <v-icon icon="mdi-download-outline" :color="actionIconColor('download')" />
      </template>
      {{ t("documentActions.download") }}
    </v-btn>

    <v-snackbar :model-value="errorMessage !== null" color="error" :timeout="4000" @update:model-value="errorMessage = null">
      {{ t("documentActions.error", { code: errorMessage }) }}
    </v-snackbar>

    <v-dialog v-model="previewOpen" max-width="900" scrollable>
      <v-card variant="outlined" rounded="lg" class="doc-actions__preview-card">
        <v-card-title class="d-flex align-center">
          <span>{{ t("documentActions.previewTitle") }}</span>
          <v-spacer />
          <v-btn
            variant="text"
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
        <v-card-text class="pa-0 doc-actions__preview-body">
          <div v-if="previewLoading" class="pa-8 text-center">
            <v-progress-circular indeterminate />
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
</style>
