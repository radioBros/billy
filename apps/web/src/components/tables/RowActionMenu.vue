<script setup lang="ts">
/**
 * RowActionMenu — the reusable 3-dot overflow menu for a ServerTable row.
 * DRY across every list: the parent passes a flat list of `RowAction`s (Open,
 * Clone, and any lifecycle/destructive items) and, optionally, a `documentType`
 * + `documentId` to get built-in Preview/Download items backed by the shared
 * useDocumentActions composable (so no logic is duplicated per list).
 *
 * The menu stops row-click propagation so opening it never triggers the row's
 * navigate-to-detail handler.
 *
 * Phone (< 600px): the dropdown becomes a bottom sheet with full-height (52px)
 * touch rows, and the preview opens fullscreen with the A4 document scaled to
 * the screen width.
 */
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useDocumentActions, type DocumentType } from "@/composables/useDocumentActions";
import { actionIconColor } from "@/constants/iconColors";
import { useIsMobile } from "@/composables/useIsMobile";

export interface RowAction {
  /** Stable key (also used for test hooks). */
  key: string;
  /** Already-translated label. */
  title: string;
  icon?: string;
  /** `error`/`warning` render the item in a destructive colour. */
  tone?: "error" | "warning";
  handler: () => void;
}

const props = withDefaults(
  defineProps<{
    actions: RowAction[];
    /** When set, adds built-in Preview + Download items. */
    documentType?: DocumentType | null;
    documentId?: string | null;
  }>(),
  { documentType: null, documentId: null },
);

const { t } = useI18n();
const isMobile = useIsMobile();
/** Phone: the actions bottom sheet. */
const sheetOpen = ref(false);

const {
  previewOpen,
  previewHtml,
  previewLoading,
  downloading,
  errorMessage,
  openPreview,
  download,
} = useDocumentActions(
  () => (props.documentType ?? "invoice") as DocumentType,
  () => props.documentId ?? "",
);

const iframeRef = ref<HTMLIFrameElement | null>(null);

/** Phone: lay the document out at a tablet-ish width and shrink it to the
 *  screen via CSS zoom, so it reads like a page instead of a squeezed column
 *  whose totals overflow. Widens the layout until nothing overflows. */
const PREVIEW_LAYOUT_PX = 640;
const fitToWidth = (): void => {
  if (!isMobile.value) return;
  const doc = iframeRef.value?.contentDocument?.documentElement;
  const avail = iframeRef.value?.clientWidth ?? 0;
  if (!doc || !avail) return;
  for (let layout = PREVIEW_LAYOUT_PX; layout <= 1200; layout += 80) {
    doc.style.zoom = String(avail / layout);
    if (doc.scrollWidth <= doc.clientWidth + 1) return;
  }
};

const printIframe = (): void => {
  const doc = iframeRef.value?.contentDocument?.documentElement;
  const zoom = doc?.style.zoom ?? "";
  if (doc) doc.style.zoom = ""; // print at the document's own size
  iframeRef.value?.contentWindow?.print();
  if (doc) doc.style.zoom = zoom;
};

/** Phone sheet rows close the sheet before running the action. */
const runFromSheet = (fn: () => void): void => {
  sheetOpen.value = false;
  fn();
};
</script>

<template>
  <div @click.stop>
    <template v-if="isMobile">
      <v-btn
        icon="mdi-dots-vertical"
        variant="text"
        class="row-actions__mobile-btn"
        :aria-label="t('rowActions.menu')"
        @click="sheetOpen = true"
      />
      <v-bottom-sheet v-model="sheetOpen" inset>
        <v-card class="row-actions__sheet" rounded="t-xl">
          <div class="row-actions__grip" />
          <v-list class="row-actions__sheet-list" bg-color="transparent">
            <v-list-item
              v-for="a in actions"
              :key="a.key"
              :data-row-action="a.key"
              :base-color="a.tone"
              @click="runFromSheet(a.handler)"
            >
              <template v-if="a.icon" #prepend>
                <v-icon :icon="a.icon" :color="actionIconColor(a.key, a.tone)" />
              </template>
              <v-list-item-title>{{ a.title }}</v-list-item-title>
            </v-list-item>

            <template v-if="documentType && documentId">
              <v-divider v-if="actions.length" class="my-1" />
              <v-list-item data-row-action="preview" @click="runFromSheet(openPreview)">
                <template #prepend>
                  <v-icon icon="mdi-eye-outline" :color="actionIconColor('preview')" />
                </template>
                <v-list-item-title>{{ t("documentActions.preview") }}</v-list-item-title>
              </v-list-item>
              <v-list-item data-row-action="download" :disabled="downloading" @click="runFromSheet(download)">
                <template #prepend>
                  <v-icon icon="mdi-download-outline" :color="actionIconColor('download')" />
                </template>
                <v-list-item-title>{{ t("documentActions.download") }}</v-list-item-title>
              </v-list-item>
            </template>
          </v-list>
        </v-card>
      </v-bottom-sheet>
    </template>

    <v-menu v-else location="bottom end">
      <template #activator="{ props: menuProps }">
        <v-btn
          icon="mdi-dots-vertical"
          variant="text"
          size="small"
          density="comfortable"
          :aria-label="t('rowActions.menu')"
          v-bind="menuProps"
        />
      </template>
      <v-list density="compact" min-width="180">
        <v-list-item
          v-for="a in actions"
          :key="a.key"
          :data-row-action="a.key"
          :base-color="a.tone"
          @click="a.handler"
        >
          <template v-if="a.icon" #prepend>
            <v-icon :icon="a.icon" :color="actionIconColor(a.key, a.tone)" />
          </template>
          <v-list-item-title>{{ a.title }}</v-list-item-title>
        </v-list-item>

        <template v-if="documentType && documentId">
          <v-divider v-if="actions.length" class="my-1" />
          <v-list-item
            data-row-action="preview"
            @click="openPreview"
          >
            <template #prepend>
              <v-icon icon="mdi-eye-outline" :color="actionIconColor('preview')" />
            </template>
            <v-list-item-title>{{ t("documentActions.preview") }}</v-list-item-title>
          </v-list-item>
          <v-list-item
            data-row-action="download"
            :disabled="downloading"
            @click="download"
          >
            <template #prepend>
              <v-icon icon="mdi-download-outline" :color="actionIconColor('download')" />
            </template>
            <v-list-item-title>{{ t("documentActions.download") }}</v-list-item-title>
          </v-list-item>
        </template>
      </v-list>
    </v-menu>

    <v-snackbar
      :model-value="errorMessage !== null"
      color="error"
      :timeout="4000"
      @update:model-value="errorMessage = null"
    >
      {{ t("documentActions.error", { code: errorMessage }) }}
    </v-snackbar>

    <v-dialog v-model="previewOpen" max-width="900" scrollable :fullscreen="isMobile">
      <v-card
        variant="outlined"
        :rounded="isMobile ? 0 : 'lg'"
        :class="{ 'row-actions__preview--mobile': isMobile }"
      >
        <v-card-title class="d-flex align-center" :class="{ 'row-actions__preview-bar': isMobile }">
          <span class="row-actions__preview-title">{{ t("documentActions.previewTitle") }}</span>
          <v-spacer />
          <v-btn
            v-if="isMobile"
            icon="mdi-printer-outline"
            variant="text"
            :disabled="previewLoading"
            :aria-label="t('documentActions.print')"
            @click="printIframe"
          />
          <v-btn
            v-else
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
          <v-btn
            icon="mdi-close"
            variant="text"
            :size="isMobile ? undefined : 'small'"
            :aria-label="t('common.cancel')"
            @click="previewOpen = false"
          />
        </v-card-title>
        <v-divider />
        <v-card-text class="pa-0" :style="isMobile ? 'flex: 1 1 auto; height: auto; background: #fff' : 'height: 70vh'">
          <div v-if="previewLoading" class="pa-8 text-center">
            <v-progress-circular indeterminate />
          </div>
          <iframe
            v-else
            ref="iframeRef"
            :srcdoc="previewHtml"
            style="width: 100%; height: 100%; border: 0; background: #fff"
            sandbox="allow-same-origin allow-modals"
            :title="t('documentActions.previewTitle')"
            @load="fitToWidth"
          />
        </v-card-text>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
/* ── Phone ───────────────────────────────────────────────────────────── */
.row-actions__mobile-btn {
  width: 44px !important;
  height: 44px !important;
}
.row-actions__sheet {
  padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
}
.row-actions__grip {
  width: 40px;
  height: 4px;
  border-radius: 2px;
  margin: 8px auto 4px;
  background: rgba(var(--v-theme-on-surface), 0.2);
}
.row-actions__sheet-list :deep(.v-list-item) {
  min-height: 52px;
  padding-inline: 20px !important;
}
.row-actions__sheet-list :deep(.v-list-item-title) {
  font-size: 1rem;
}
.row-actions__preview--mobile {
  display: flex;
  flex-direction: column;
  height: 100%;
  border: 0 !important;
}
.row-actions__preview-bar {
  gap: 4px;
  padding: 4px 4px 4px 16px !important;
  min-height: 56px;
  padding-top: calc(4px + env(safe-area-inset-top, 0px)) !important;
}
.row-actions__preview-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
