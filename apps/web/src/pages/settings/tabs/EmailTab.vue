<script setup lang="ts">
/**
 * Email/SMTP tab — GET/PATCH /v1/settings/email + POST /v1/settings/email/test.
 *
 * SECURITY: the SMTP password is WRITE-ONLY. GET never returns it — only
 * `smtpConfigured`. We keep the password in a SEPARATE ref that starts blank and
 * is never populated from GET; we send `smtpPassword` in the PATCH body ONLY when
 * the admin typed a new value. A "configured ✓" chip signals a stored password.
 */
import { ref, onMounted, inject } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import type { EmailSettings, EmailSettingsUpdate, EmailTestResult } from "@/types/domain";
import { useAuthStore } from "@/stores/auth";
import { useFieldErrors } from "@/pages/settings/useFieldErrors";
import { SNACKBAR_KEY, NOOP_NOTIFY } from "@/pages/settings/snackbar";

const { t } = useI18n();
const notify = inject(SNACKBAR_KEY, NOOP_NOTIFY);
const { fieldErrors, applyError, clear } = useFieldErrors();

const loading = ref(false);
const saving = ref(false);
const testing = ref(false);
const errorMessage = ref<string | null>(null);
const testResult = ref<EmailTestResult | null>(null);

// Send a REAL test message (distinct from the connection check). Recipient
// prefills to the signed-in admin's email; editable to send anywhere.
const auth = useAuthStore();
const sending = ref(false);
const sendResult = ref<EmailTestResult | null>(null);
const testRecipient = ref<string>(auth.principal?.email ?? "");

const smtpHost = ref<string | null>(null);
const smtpPort = ref<number | null>(null);
const smtpSecure = ref(false);
const smtpUsername = ref<string | null>(null);
const fromEmail = ref<string | null>(null);
const fromName = ref<string | null>(null);
const replyTo = ref<string | null>(null);
/** Stored-password indicator from GET. The value itself is never fetched. */
const smtpConfigured = ref(false);
/** Write-only input: blank means "leave the stored password unchanged". */
const smtpPassword = ref("");
const showPassword = ref(false);

const load = async (): Promise<void> => {
  loading.value = true;
  errorMessage.value = null;
  try {
    const e = await api.get<EmailSettings>("/v1/settings/email");
    smtpHost.value = e.smtpHost;
    smtpPort.value = e.smtpPort;
    smtpSecure.value = e.smtpSecure;
    smtpUsername.value = e.smtpUsername;
    fromEmail.value = e.fromEmail;
    fromName.value = e.fromName;
    replyTo.value = e.replyTo;
    smtpConfigured.value = e.smtpConfigured;
    // Deliberately do NOT touch smtpPassword — GET carries no secret.
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.email.loadError")} (${err.code})` : t("settings.email.loadError");
  } finally {
    loading.value = false;
  }
};

const buildPayload = (): EmailSettingsUpdate => {
  const payload: EmailSettingsUpdate = {
    smtpHost: smtpHost.value,
    smtpPort: smtpPort.value,
    smtpSecure: smtpSecure.value,
    smtpUsername: smtpUsername.value,
    fromEmail: fromEmail.value,
    fromName: fromName.value,
    replyTo: replyTo.value,
  };
  // Only include the write-only password when the admin actually typed one.
  if (smtpPassword.value.length > 0) {
    payload.smtpPassword = smtpPassword.value;
  }
  return payload;
};

const save = async (): Promise<void> => {
  clear();
  errorMessage.value = null;
  saving.value = true;
  try {
    const saved = await api.patch<EmailSettings>("/v1/settings/email", buildPayload());
    smtpConfigured.value = saved.smtpConfigured;
    smtpPassword.value = ""; // clear the write-only input after a successful save
    notify(t("settings.email.saved"));
  } catch (err) {
    applyError(err);
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.email.saveError")} (${err.code})` : t("settings.email.saveError");
  } finally {
    saving.value = false;
  }
};

const testConnection = async (): Promise<void> => {
  testing.value = true;
  testResult.value = null;
  errorMessage.value = null;
  try {
    testResult.value = await api.post<EmailTestResult>("/v1/settings/email/test", {});
  } catch (err) {
    testResult.value = {
      ok: false,
      error: err instanceof ApiError ? err.message : t("settings.email.testFailed"),
    };
  } finally {
    testing.value = false;
  }
};

const sendTest = async (): Promise<void> => {
  sending.value = true;
  sendResult.value = null;
  errorMessage.value = null;
  try {
    sendResult.value = await api.post<EmailTestResult>("/v1/settings/email/send-test", {
      to: testRecipient.value.trim(),
    });
  } catch (err) {
    sendResult.value = {
      ok: false,
      error: err instanceof ApiError ? err.message : t("settings.email.testFailed"),
    };
  } finally {
    sending.value = false;
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
        <v-col cols="12" md="8">
          <v-text-field
            v-model="smtpHost"
            :label="t('settings.email.smtpHost')"
            :error-messages="fieldErrors.smtpHost"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model.number="smtpPort"
            :label="t('settings.email.smtpPort')"
            type="number"
            :error-messages="fieldErrors.smtpPort"
            density="comfortable"
          />
        </v-col>

        <v-col cols="12" md="6">
          <v-text-field
            v-model="smtpUsername"
            :label="t('settings.email.smtpUsername')"
            :error-messages="fieldErrors.smtpUsername"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="smtpPassword"
            :label="t('settings.email.smtpPassword')"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="new-password"
            :append-inner-icon="showPassword ? 'mdi-eye-off' : 'mdi-eye'"
            :hint="smtpConfigured ? t('settings.email.passwordStoredHint') : t('settings.email.passwordUnsetHint')"
            persistent-hint
            :error-messages="fieldErrors.smtpPassword"
            density="comfortable"
            @click:append-inner="showPassword = !showPassword"
          >
            <template v-if="smtpConfigured" #append>
              <v-chip color="success" size="small" variant="tonal" prepend-icon="mdi-check">
                {{ t("settings.email.configured") }}
              </v-chip>
            </template>
          </v-text-field>
        </v-col>

        <v-col cols="12" md="4">
          <v-switch
            v-model="smtpSecure"
            :label="t('settings.email.smtpSecure')"
            color="primary"
            hide-details
            :error-messages="fieldErrors.smtpSecure"
          />
        </v-col>

        <v-col cols="12" md="6">
          <v-text-field
            v-model="fromEmail"
            :label="t('settings.email.fromEmail')"
            type="email"
            :error-messages="fieldErrors.fromEmail"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="fromName"
            :label="t('settings.email.fromName')"
            :error-messages="fieldErrors.fromName"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="replyTo"
            :label="t('settings.email.replyTo')"
            type="email"
            :error-messages="fieldErrors.replyTo"
            density="comfortable"
          />
        </v-col>
      </v-row>

      <v-alert
        v-if="testResult"
        :type="testResult.ok ? 'success' : 'error'"
        variant="tonal"
        density="compact"
        class="mt-2 mb-2"
        role="status"
      >
        {{ testResult.ok ? t("settings.email.testOk") : t("settings.email.testError", { error: testResult.error ?? t("settings.email.unknownError") }) }}
      </v-alert>

      <!-- Send a REAL test message to a chosen recipient (distinct from the
           connection check above). -->
      <v-row class="mt-1" align="center">
        <v-col cols="12" md="8">
          <v-text-field
            v-model="testRecipient"
            :label="t('settings.email.testRecipient')"
            type="email"
            density="comfortable"
            hide-details
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-btn
            variant="tonal"
            color="teal"
            block
            :loading="sending"
            :disabled="!testRecipient.trim()"
            prepend-icon="mdi-send-outline"
            @click="sendTest"
          >
            {{ t("settings.email.sendTest") }}
          </v-btn>
        </v-col>
      </v-row>
      <v-alert
        v-if="sendResult"
        :type="sendResult.ok ? 'success' : 'error'"
        variant="tonal"
        density="compact"
        class="mt-2 mb-2"
        role="status"
      >
        {{ sendResult.ok ? t("settings.email.sendOk", { to: testRecipient }) : t("settings.email.testError", { error: sendResult.error ?? t("settings.email.unknownError") }) }}
      </v-alert>

      <div class="d-flex mt-2" style="gap: 12px">
        <v-spacer />
        <v-btn variant="outlined" :loading="testing" prepend-icon="mdi-email-fast-outline" @click="testConnection">
          {{ t("settings.email.testConnection") }}
        </v-btn>
        <v-btn color="primary" type="submit" :loading="saving">{{ t("settings.email.save") }}</v-btn>
      </div>
    </v-form>
    </v-card-text>
  </v-card>
</template>
