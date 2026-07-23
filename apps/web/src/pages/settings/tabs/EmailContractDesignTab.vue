<script setup lang="ts">
/**
 * Email & Contract Design tab — configures the header/footer HTML that wraps
 * rendered contracts and outgoing emails. Four WYSIWYG fields (RichTextEditor,
 * with source view) bound to the `documents` settings group:
 *   contractHeaderHtml / contractFooterHtml / emailHeaderHtml / emailFooterHtml.
 *
 * Loads + PATCHes /v1/settings/documents. Only this subset is sent so the
 * numbering + document-design fields the other tabs own are left intact
 * (partial PATCH). Flat theme: outlined card, no shadow.
 */
import { ref, onMounted, inject } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import type { DocumentSettings } from "@/types/domain";
import { SNACKBAR_KEY, NOOP_NOTIFY } from "@/pages/settings/snackbar";
import SettingsSection from "@/pages/settings/SettingsSection.vue";
import LocalizedTextEditor from "@/components/LocalizedTextEditor.vue";
import { toLocalizedMap } from "@billy/shared/localized-text";

const { t } = useI18n();
const notify = inject(SNACKBAR_KEY, NOOP_NOTIFY);

const loading = ref(false);
const saving = ref(false);
const errorMessage = ref<string | null>(null);

// Per-locale maps for the LocalizedTextEditor; loaded via toLocalizedMap and
// coerced back to null on save when the map is empty ("cleared" semantics).
const contractHeaderHtml = ref<Record<string, string>>({});
const contractFooterHtml = ref<Record<string, string>>({});
const emailHeaderHtml = ref<Record<string, string>>({});
const emailFooterHtml = ref<Record<string, string>>({});

/** A localized-text map ready for the API: send null when it has no content. */
const mapOrNull = (map: Record<string, string>): Record<string, string> | null => {
  const kept = Object.fromEntries(Object.entries(map).filter(([, v]) => v.trim().length > 0));
  return Object.keys(kept).length > 0 ? kept : null;
};

const load = async (): Promise<void> => {
  loading.value = true;
  errorMessage.value = null;
  try {
    const docs = await api.get<DocumentSettings>("/v1/settings/documents");
    contractHeaderHtml.value = toLocalizedMap(docs.contractHeaderHtml);
    contractFooterHtml.value = toLocalizedMap(docs.contractFooterHtml);
    emailHeaderHtml.value = toLocalizedMap(docs.emailHeaderHtml);
    emailFooterHtml.value = toLocalizedMap(docs.emailFooterHtml);
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.emailContract.loadError")} (${err.code})` : t("settings.emailContract.loadError");
  } finally {
    loading.value = false;
  }
};

const save = async (): Promise<void> => {
  errorMessage.value = null;
  saving.value = true;
  const payload: Partial<DocumentSettings> = {
    contractHeaderHtml: mapOrNull(contractHeaderHtml.value),
    contractFooterHtml: mapOrNull(contractFooterHtml.value),
    emailHeaderHtml: mapOrNull(emailHeaderHtml.value),
    emailFooterHtml: mapOrNull(emailFooterHtml.value),
  };
  try {
    await api.patch<DocumentSettings>("/v1/settings/documents", payload);
    notify(t("settings.emailContract.saved"));
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.emailContract.saveError")} (${err.code})` : t("settings.emailContract.saveError");
  } finally {
    saving.value = false;
  }
};

onMounted(() => {
  void load();
});
</script>

<template>
  <v-card variant="outlined" rounded="lg">
    <v-card-text>
    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
    </v-alert>

    <div v-if="loading" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </div>

    <v-form v-else @submit.prevent="save">
      <SettingsSection first :title="t('settings.emailContract.contractTitle')" :hint="t('settings.emailContract.contractHint')">
        <LocalizedTextEditor
          v-model="contractHeaderHtml"
          :label="t('settings.emailContract.contractHeader')"
          mode="rich"
          class="mb-4"
        />
        <LocalizedTextEditor
          v-model="contractFooterHtml"
          :label="t('settings.emailContract.contractFooter')"
          mode="rich"
        />
      </SettingsSection>

      <SettingsSection :title="t('settings.emailContract.emailTitle')" :hint="t('settings.emailContract.emailHint')">
        <LocalizedTextEditor
          v-model="emailHeaderHtml"
          :label="t('settings.emailContract.emailHeader')"
          mode="rich"
          class="mb-4"
        />
        <LocalizedTextEditor
          v-model="emailFooterHtml"
          :label="t('settings.emailContract.emailFooter')"
          mode="rich"
        />
      </SettingsSection>

      <div class="d-flex mt-4" style="gap: 12px">
        <v-spacer />
        <v-btn color="primary" type="submit" :loading="saving">{{ t("settings.emailContract.save") }}</v-btn>
      </div>
    </v-form>
    </v-card-text>
  </v-card>
</template>
