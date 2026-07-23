<script setup lang="ts">
/** Localization tab — GET/PATCH /v1/settings/localization. */
import { ref, computed, onMounted, inject } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import type { LocalizationSettings } from "@/types/domain";
import { useFieldErrors } from "@/pages/settings/useFieldErrors";
import { SNACKBAR_KEY, NOOP_NOTIFY } from "@/pages/settings/snackbar";
import { LOCALES, normalizeLocale } from "@billy/shared/locales";

const { t } = useI18n();
const notify = inject(SNACKBAR_KEY, NOOP_NOTIFY);
const { fieldErrors, applyError, clear } = useFieldErrors();

const loading = ref(false);
const saving = ref(false);
const errorMessage = ref<string | null>(null);

const defaultCurrency = ref("EUR");
const defaultLocale = ref("en");
const timezone = ref("UTC");
const dateFormat = ref("YYYY-MM-DD");
const numberFormat = ref("1,234.56");
const firstDayOfWeek = ref(1);

const weekdays = computed(() => [
  { title: t("settings.localization.weekdaySunday"), value: 0 },
  { title: t("settings.localization.weekdayMonday"), value: 1 },
  { title: t("settings.localization.weekdaySaturday"), value: 6 },
]);

// Locale dropdown items, sourced from the shared LOCALES source of truth (native
// name shown, base ISO-639-1 code stored — matching the backend LanguageEnum).
const localeOptions = LOCALES.map((l) => ({ title: l.nativeName, value: l.code }));

const load = async (): Promise<void> => {
  loading.value = true;
  errorMessage.value = null;
  try {
    const s = await api.get<LocalizationSettings>("/v1/settings/localization");
    defaultCurrency.value = s.defaultCurrency;
    // Normalize any stored/legacy tag ("en-US") to a supported base code so the
    // dropdown resolves to a real option instead of rendering blank.
    defaultLocale.value = normalizeLocale(s.defaultLocale);
    timezone.value = s.timezone;
    dateFormat.value = s.dateFormat;
    numberFormat.value = s.numberFormat;
    firstDayOfWeek.value = s.firstDayOfWeek;
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.localization.loadError")} (${err.code})` : t("settings.localization.loadError");
  } finally {
    loading.value = false;
  }
};

const save = async (): Promise<void> => {
  clear();
  errorMessage.value = null;
  saving.value = true;
  const payload: LocalizationSettings = {
    defaultCurrency: defaultCurrency.value,
    defaultLocale: defaultLocale.value,
    timezone: timezone.value,
    dateFormat: dateFormat.value,
    numberFormat: numberFormat.value,
    firstDayOfWeek: firstDayOfWeek.value,
  };
  try {
    await api.patch<LocalizationSettings>("/v1/settings/localization", payload);
    notify(t("settings.localization.saved"));
  } catch (err) {
    applyError(err);
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.localization.saveError")} (${err.code})` : t("settings.localization.saveError");
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
            v-model="defaultCurrency"
            :label="t('settings.localization.defaultCurrency')"
            :error-messages="fieldErrors.defaultCurrency"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-select
            v-model="defaultLocale"
            :label="t('settings.localization.defaultLocale')"
            :items="localeOptions"
            item-title="title"
            item-value="value"
            :error-messages="fieldErrors.defaultLocale"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="timezone"
            :label="t('settings.localization.timezone')"
            :error-messages="fieldErrors.timezone"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="dateFormat"
            :label="t('settings.localization.dateFormat')"
            :error-messages="fieldErrors.dateFormat"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="numberFormat"
            :label="t('settings.localization.numberFormat')"
            :error-messages="fieldErrors.numberFormat"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-select
            v-model="firstDayOfWeek"
            :label="t('settings.localization.firstDayOfWeek')"
            :items="weekdays"
            item-title="title"
            item-value="value"
            :error-messages="fieldErrors.firstDayOfWeek"
            density="comfortable"
          />
        </v-col>
      </v-row>

      <div class="d-flex mt-2" style="gap: 12px">
        <v-spacer />
        <v-btn color="primary" type="submit" :loading="saving">{{ t("settings.localization.save") }}</v-btn>
      </div>
    </v-form>
    </v-card-text>
  </v-card>
</template>
