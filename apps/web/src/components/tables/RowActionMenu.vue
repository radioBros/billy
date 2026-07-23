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
 */
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useDocumentActions, type DocumentType } from "@/composables/useDocumentActions";
import { actionIconColor } from "@/constants/iconColors";

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
const printIframe = (): void => {
  iframeRef.value?.contentWindow?.print();
};
</script>

<template>
  <div @click.stop>
    <v-menu location="bottom end">
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

    <v-dialog v-model="previewOpen" max-width="900" scrollable>
      <v-card variant="outlined" rounded="lg">
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
        <v-card-text class="pa-0" style="height: 70vh">
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
          />
        </v-card-text>
      </v-card>
    </v-dialog>
  </div>
</template>
