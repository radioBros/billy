<script setup lang="ts">
/** Advanced tab — GET/PATCH /v1/settings/toggles (policy / feature toggles). */
import { ref, computed, onMounted, inject } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import type { ToggleSettings } from "@/types/domain";
import { useFieldErrors } from "@/pages/settings/useFieldErrors";
import { SNACKBAR_KEY, NOOP_NOTIFY } from "@/pages/settings/snackbar";

const { t } = useI18n();
const notify = inject(SNACKBAR_KEY, NOOP_NOTIFY);
const { fieldErrors, applyError, clear } = useFieldErrors();

const loading = ref(false);
const saving = ref(false);
const errorMessage = ref<string | null>(null);

// require2fa is intentionally NOT exposed here — org-wide "force 2FA" is replaced by
// per-user TOTP in User Settings. The backend field still exists; we simply never
// send it from this tab (the toggles PATCH is partial), so it's left untouched.
const clamavEnabled = ref(false);
const backupEnabled = ref(false);
const backupSchedule = ref("0 3 * * *");
const backupRetentionDays = ref(30);
const softDeleteRetentionDays = ref(90);
const uploadMaxBytes = ref(10_485_760);
const sessionIdleTtlMinutes = ref(60);
const sessionAbsoluteTtlMinutes = ref(720);
const allowPublicLinks = ref(true);

/** UI-only proxy: edit the upload cap in MB while the backend keeps bytes. */
const uploadMaxMb = computed<number>({
  get: () => Math.round(uploadMaxBytes.value / 1_048_576),
  set: (mb) => {
    uploadMaxBytes.value = mb * 1_048_576;
  },
});

const load = async (): Promise<void> => {
  loading.value = true;
  errorMessage.value = null;
  try {
    const s = await api.get<ToggleSettings>("/v1/settings/toggles");
    clamavEnabled.value = s.clamavEnabled;
    backupEnabled.value = s.backupEnabled;
    backupSchedule.value = s.backupSchedule;
    backupRetentionDays.value = s.backupRetentionDays;
    softDeleteRetentionDays.value = s.softDeleteRetentionDays;
    uploadMaxBytes.value = s.uploadMaxBytes;
    sessionIdleTtlMinutes.value = s.sessionIdleTtlMinutes;
    sessionAbsoluteTtlMinutes.value = s.sessionAbsoluteTtlMinutes;
    allowPublicLinks.value = s.allowPublicLinks;
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.advanced.loadError")} (${err.code})` : t("settings.advanced.loadError");
  } finally {
    loading.value = false;
  }
};

const save = async (): Promise<void> => {
  clear();
  errorMessage.value = null;
  saving.value = true;
  // Omit require2fa (partial PATCH) — this tab no longer owns it.
  const payload: Partial<ToggleSettings> = {
    clamavEnabled: clamavEnabled.value,
    backupEnabled: backupEnabled.value,
    backupSchedule: backupSchedule.value,
    backupRetentionDays: backupRetentionDays.value,
    softDeleteRetentionDays: softDeleteRetentionDays.value,
    uploadMaxBytes: uploadMaxBytes.value,
    sessionIdleTtlMinutes: sessionIdleTtlMinutes.value,
    sessionAbsoluteTtlMinutes: sessionAbsoluteTtlMinutes.value,
    allowPublicLinks: allowPublicLinks.value,
  };
  try {
    await api.patch<ToggleSettings>("/v1/settings/toggles", payload);
    notify(t("settings.advanced.saved"));
  } catch (err) {
    applyError(err);
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.advanced.saveError")} (${err.code})` : t("settings.advanced.saveError");
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
            v-model.number="backupRetentionDays"
            :label="t('settings.advanced.backupRetentionDays')"
            type="number"
            :error-messages="fieldErrors.backupRetentionDays"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model.number="softDeleteRetentionDays"
            :label="t('settings.advanced.softDeleteRetentionDays')"
            type="number"
            :error-messages="fieldErrors.softDeleteRetentionDays"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model.number="sessionIdleTtlMinutes"
            :label="t('settings.advanced.sessionIdleTtlMinutes')"
            type="number"
            :error-messages="fieldErrors.sessionIdleTtlMinutes"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model.number="sessionAbsoluteTtlMinutes"
            :label="t('settings.advanced.sessionAbsoluteTtlMinutes')"
            type="number"
            :error-messages="fieldErrors.sessionAbsoluteTtlMinutes"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model.number="uploadMaxMb"
            :label="t('settings.advanced.uploadMaxMb')"
            type="number"
            suffix="MB"
            :error-messages="fieldErrors.uploadMaxBytes"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="backupSchedule"
            :label="t('settings.advanced.backupSchedule')"
            :error-messages="fieldErrors.backupSchedule"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-switch
            v-model="clamavEnabled"
            :label="t('settings.advanced.clamavEnabled')"
            color="primary"
            hide-details
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-switch
            v-model="backupEnabled"
            :label="t('settings.advanced.backupEnabled')"
            color="primary"
            hide-details
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-switch
            v-model="allowPublicLinks"
            :label="t('settings.advanced.allowPublicLinks')"
            color="primary"
            hide-details
          />
        </v-col>
      </v-row>

      <div class="d-flex mt-2" style="gap: 12px">
        <v-spacer />
        <v-btn color="primary" type="submit" :loading="saving">{{ t("settings.advanced.save") }}</v-btn>
      </div>
    </v-form>
    </v-card-text>
  </v-card>
</template>
