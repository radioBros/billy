<script setup lang="ts">
/** Documents tab — GET/PATCH /v1/settings/documents (defaults + default notes).
 *  Binds the REAL `documents` settings group fields (was previously built against
 *  a phantom shape — numberPrefix/numberPadding/defaultPaymentTerms/defaultNotes —
 *  that the schema silently stripped, so nothing persisted). */
import { ref, onMounted, inject } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import type { DocumentSettings } from "@/types/domain";
import { useFieldErrors } from "@/pages/settings/useFieldErrors";
import { SNACKBAR_KEY, NOOP_NOTIFY } from "@/pages/settings/snackbar";
import LocalizedTextEditor from "@/components/LocalizedTextEditor.vue";
import { toLocalizedMap } from "@billy/shared/localized-text";

const { t } = useI18n();
const notify = inject(SNACKBAR_KEY, NOOP_NOTIFY);
const { fieldErrors, applyError, clear } = useFieldErrors();

const loading = ref(false);
const saving = ref(false);
const errorMessage = ref<string | null>(null);

const defaultPaymentTermsDays = ref(30);
const defaultTaxRate = ref(0);
// Per-locale maps for the LocalizedTextEditor; loaded via toLocalizedMap and
// coerced back to null on save when the map is empty.
const invoiceNotes = ref<Record<string, string>>({});
const quoteNotes = ref<Record<string, string>>({});

/** A localized-text map ready for the API: send null when it has no content. */
const mapOrNull = (map: Record<string, string>): Record<string, string> | null => {
  const kept = Object.fromEntries(Object.entries(map).filter(([, v]) => v.trim().length > 0));
  return Object.keys(kept).length > 0 ? kept : null;
};

const load = async (): Promise<void> => {
  loading.value = true;
  errorMessage.value = null;
  try {
    const s = await api.get<DocumentSettings>("/v1/settings/documents");
    defaultPaymentTermsDays.value = s.defaultPaymentTermsDays;
    defaultTaxRate.value = s.defaultTaxRate;
    invoiceNotes.value = toLocalizedMap(s.invoiceNotes);
    quoteNotes.value = toLocalizedMap(s.quoteNotes);
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.documentsTab.loadError")} (${err.code})` : t("settings.documentsTab.loadError");
  } finally {
    loading.value = false;
  }
};

const save = async (): Promise<void> => {
  clear();
  errorMessage.value = null;
  saving.value = true;
  // Partial PATCH — only the fields this tab owns (design/logo/bank + email/contract
  // header-footer are owned by other tabs and left untouched).
  const payload: Partial<DocumentSettings> = {
    defaultPaymentTermsDays: defaultPaymentTermsDays.value,
    defaultTaxRate: defaultTaxRate.value,
    invoiceNotes: mapOrNull(invoiceNotes.value),
    quoteNotes: mapOrNull(quoteNotes.value),
  };
  try {
    await api.patch<DocumentSettings>("/v1/settings/documents", payload);
    notify(t("settings.documentsTab.saved"));
  } catch (err) {
    applyError(err);
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.documentsTab.saveError")} (${err.code})` : t("settings.documentsTab.saveError");
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
      <v-row>
        <v-col cols="12" md="6">
          <v-text-field
            v-model.number="defaultPaymentTermsDays"
            :label="t('settings.documentsTab.defaultPaymentTermsDays')"
            type="number"
            :error-messages="fieldErrors.defaultPaymentTermsDays"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model.number="defaultTaxRate"
            :label="t('settings.documentsTab.defaultTaxRate')"
            type="number"
            suffix="%"
            :error-messages="fieldErrors.defaultTaxRate"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12">
          <LocalizedTextEditor
            v-model="invoiceNotes"
            :label="t('settings.documentsTab.invoiceNotes')"
            mode="textarea"
          />
        </v-col>
        <v-col cols="12">
          <LocalizedTextEditor
            v-model="quoteNotes"
            :label="t('settings.documentsTab.quoteNotes')"
            mode="textarea"
          />
        </v-col>
      </v-row>

      <div class="d-flex mt-2" style="gap: 12px">
        <v-spacer />
        <v-btn color="primary" type="submit" :loading="saving">{{ t("settings.documentsTab.save") }}</v-btn>
      </div>
    </v-form>
    </v-card-text>
  </v-card>
</template>
