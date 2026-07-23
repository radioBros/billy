<script setup lang="ts">
/**
 * User Settings tab — available to EVERY authenticated user. Two sections:
 *  1. Change password (POST /v1/auth/change-password). The server revokes OTHER
 *     sessions but keeps THIS one, so we do NOT force a re-login.
 *  2. Two-factor auth: enable (setup → QR → verify → show 10 backup codes ONCE)
 *     or disable (code or password → /totp/disable).
 * A `mustChangePassword` notice is shown when the principal is flagged; it clears
 * locally after a successful change.
 */
import { ref, computed, inject } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import { useAuthStore } from "@/stores/auth";
import type { TotpSetup } from "@/types/domain";
import { useFieldErrors } from "@/pages/settings/useFieldErrors";
import { SNACKBAR_KEY, NOOP_NOTIFY } from "@/pages/settings/snackbar";

const { t } = useI18n();
const notify = inject(SNACKBAR_KEY, NOOP_NOTIFY);
const auth = useAuthStore();
const { fieldErrors, applyError, clear } = useFieldErrors();

const mustChangePassword = computed(() => auth.principal?.mustChangePassword === true);
const totpEnabled = computed(() => auth.principal?.amrTwoFactor === true || totpJustEnabled.value);
const totpJustEnabled = ref(false);

// ── Change password ──────────────────────────────────────────────────────────
const currentPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const showCurrent = ref(false);
const showNew = ref(false);
const showConfirm = ref(false);
const pwSaving = ref(false);
const pwError = ref<string | null>(null);

const changePassword = async (): Promise<void> => {
  clear();
  pwError.value = null;
  if (newPassword.value.length < 8) {
    pwError.value = t("userSettings.password.errors.tooShort");
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    pwError.value = t("userSettings.password.errors.mismatch");
    return;
  }
  pwSaving.value = true;
  try {
    await api.post<{ ok: true }>("/v1/auth/change-password", {
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    });
    auth.clearMustChangePassword();
    currentPassword.value = "";
    newPassword.value = "";
    confirmPassword.value = "";
    notify(t("userSettings.password.saved"));
  } catch (err) {
    applyError(err);
    if (err instanceof ApiError && err.code === "INVALID_CREDENTIALS") {
      pwError.value = t("userSettings.password.errors.wrongCurrent");
    } else {
      pwError.value =
        err instanceof ApiError ? `${t("userSettings.password.errors.generic")} (${err.code})` : t("userSettings.password.errors.generic");
    }
  } finally {
    pwSaving.value = false;
  }
};

// ── TOTP enable flow ───────────────────────────────────────────────────────────
const setup = ref<TotpSetup | null>(null);
const enableCode = ref("");
const backupCodes = ref<string[] | null>(null);
const totpBusy = ref(false);
const totpError = ref<string | null>(null);

const startEnable = async (): Promise<void> => {
  totpError.value = null;
  totpBusy.value = true;
  try {
    setup.value = await api.post<TotpSetup>("/v1/auth/totp/setup");
    enableCode.value = "";
  } catch (err) {
    totpError.value = err instanceof ApiError ? `${t("userSettings.totp.errors.setup")} (${err.code})` : t("userSettings.totp.errors.setup");
  } finally {
    totpBusy.value = false;
  }
};

const confirmEnable = async (): Promise<void> => {
  totpError.value = null;
  totpBusy.value = true;
  try {
    const res = await api.post<{ enabled: true; backupCodes: string[] }>("/v1/auth/totp/enable", {
      code: enableCode.value.trim(),
    });
    backupCodes.value = res.backupCodes;
    totpJustEnabled.value = true;
    setup.value = null;
    enableCode.value = "";
    notify(t("userSettings.totp.enabledToast"));
  } catch (err) {
    totpError.value =
      err instanceof ApiError && (err.code === "TWO_FACTOR_INVALID" || err.code === "INVALID_CREDENTIALS")
        ? t("userSettings.totp.errors.badCode")
        : err instanceof ApiError
          ? `${t("userSettings.totp.errors.enable")} (${err.code})`
          : t("userSettings.totp.errors.enable");
  } finally {
    totpBusy.value = false;
  }
};

const cancelEnable = (): void => {
  setup.value = null;
  enableCode.value = "";
  totpError.value = null;
};

const dismissBackupCodes = (): void => {
  backupCodes.value = null;
};

const copyOtpauth = async (): Promise<void> => {
  if (!setup.value) return;
  try {
    await navigator.clipboard.writeText(setup.value.otpauthUrl);
    notify(t("userSettings.totp.copied"));
  } catch {
    // Clipboard unavailable (e.g. insecure context); the URL stays visible to copy manually.
  }
};

// ── TOTP disable flow ──────────────────────────────────────────────────────────
const disableDialog = ref(false);
const disableCode = ref("");

const openDisable = (): void => {
  disableCode.value = "";
  totpError.value = null;
  disableDialog.value = true;
};

const confirmDisable = async (): Promise<void> => {
  totpError.value = null;
  totpBusy.value = true;
  try {
    await api.post<{ enabled: false }>("/v1/auth/totp/disable", { code: disableCode.value.trim() });
    totpJustEnabled.value = false;
    if (auth.principal) auth.principal.amrTwoFactor = false;
    disableDialog.value = false;
    notify(t("userSettings.totp.disabledToast"));
  } catch (err) {
    totpError.value =
      err instanceof ApiError && (err.code === "TWO_FACTOR_INVALID" || err.code === "INVALID_CREDENTIALS")
        ? t("userSettings.totp.errors.badCode")
        : err instanceof ApiError
          ? `${t("userSettings.totp.errors.disable")} (${err.code})`
          : t("userSettings.totp.errors.disable");
  } finally {
    totpBusy.value = false;
  }
};
</script>

<template>
  <div class="d-flex flex-column" style="gap: 16px">
    <v-alert
      v-if="mustChangePassword"
      type="warning"
      variant="tonal"
      density="comfortable"
      role="alert"
    >
      {{ t("userSettings.mustChangePasswordNotice") }}
    </v-alert>

    <!-- Change password -->
    <v-card variant="outlined" rounded="lg">
      <v-card-text>
      <div class="text-subtitle-1 font-weight-medium mb-1">{{ t("userSettings.password.title") }}</div>
      <div class="text-caption text-medium-emphasis mb-4">{{ t("userSettings.password.hint") }}</div>

      <v-alert v-if="pwError" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
        {{ pwError }}
      </v-alert>

      <v-form @submit.prevent="changePassword">
        <v-text-field
          v-model="currentPassword"
          :label="t('userSettings.password.current')"
          :error-messages="fieldErrors.currentPassword"
          :type="showCurrent ? 'text' : 'password'"
          :append-inner-icon="showCurrent ? 'mdi-eye-off' : 'mdi-eye'"
          autocomplete="current-password"
          density="comfortable"
          required
          @click:append-inner="showCurrent = !showCurrent"
        />
        <v-text-field
          v-model="newPassword"
          :label="t('userSettings.password.new')"
          :error-messages="fieldErrors.newPassword"
          :hint="t('userSettings.password.minHint')"
          persistent-hint
          :type="showNew ? 'text' : 'password'"
          :append-inner-icon="showNew ? 'mdi-eye-off' : 'mdi-eye'"
          autocomplete="new-password"
          density="comfortable"
          required
          @click:append-inner="showNew = !showNew"
        />
        <v-text-field
          v-model="confirmPassword"
          :label="t('userSettings.password.confirm')"
          :type="showConfirm ? 'text' : 'password'"
          :append-inner-icon="showConfirm ? 'mdi-eye-off' : 'mdi-eye'"
          autocomplete="new-password"
          density="comfortable"
          class="mt-2"
          required
          @click:append-inner="showConfirm = !showConfirm"
        />
        <div class="d-flex mt-4">
          <v-spacer />
          <v-btn color="primary" type="submit" :loading="pwSaving">{{ t("userSettings.password.save") }}</v-btn>
        </div>
      </v-form>
      </v-card-text>
    </v-card>

    <!-- Two-factor -->
    <v-card variant="outlined" rounded="lg">
      <v-card-text>
      <div class="d-flex align-center mb-1">
        <div class="text-subtitle-1 font-weight-medium">{{ t("userSettings.totp.title") }}</div>
        <v-spacer />
        <v-chip v-if="totpEnabled" color="success" size="small" variant="tonal">
          {{ t("userSettings.totp.statusEnabled") }}
        </v-chip>
        <v-chip v-else size="small" variant="tonal">{{ t("userSettings.totp.statusDisabled") }}</v-chip>
      </div>
      <div class="text-caption text-medium-emphasis mb-4">{{ t("userSettings.totp.hint") }}</div>

      <v-alert v-if="totpError" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
        {{ totpError }}
      </v-alert>

      <!-- Backup codes (shown once after enabling) -->
      <div v-if="backupCodes">
        <v-alert type="success" variant="tonal" density="comfortable" class="mb-3" role="alert">
          {{ t("userSettings.totp.backupWarning") }}
        </v-alert>
        <v-sheet border rounded class="pa-3 mb-3" role="list" :aria-label="t('userSettings.totp.backupCodesLabel')">
          <div class="d-flex flex-wrap" style="gap: 8px 24px">
            <code v-for="c in backupCodes" :key="c" class="text-body-1" role="listitem">{{ c }}</code>
          </div>
        </v-sheet>
        <div class="d-flex">
          <v-spacer />
          <v-btn color="primary" variant="flat" @click="dismissBackupCodes">
            {{ t("userSettings.totp.backupSaved") }}
          </v-btn>
        </div>
      </div>

      <!-- Enabled state -->
      <div v-else-if="totpEnabled" class="d-flex">
        <v-spacer />
        <v-btn color="error" variant="tonal" @click="openDisable">{{ t("userSettings.totp.disable") }}</v-btn>
      </div>

      <!-- Setup in progress -->
      <div v-else-if="setup">
        <div class="d-flex flex-column align-center mb-3">
          <img
            :src="setup.qrDataUrl"
            :alt="t('userSettings.totp.qrAlt')"
            width="200"
            height="200"
            style="image-rendering: pixelated"
          />
        </div>
        <v-text-field
          :model-value="setup.otpauthUrl"
          :label="t('userSettings.totp.otpauthUrl')"
          readonly
          density="comfortable"
          append-inner-icon="mdi-content-copy"
          @click:append-inner="copyOtpauth"
        />
        <!-- Fresh 6-digit code from the authenticator → segmented OTP input. -->
        <div class="text-body-2 text-medium-emphasis mt-2 mb-1">{{ t("userSettings.totp.enterCode") }}</div>
        <v-otp-input
          v-model="enableCode"
          :length="6"
          type="number"
          :disabled="totpBusy"
          @finish="confirmEnable"
        />
        <div class="d-flex mt-2" style="gap: 12px">
          <v-btn variant="text" :disabled="totpBusy" @click="cancelEnable">{{ t("common.cancel") }}</v-btn>
          <v-spacer />
          <v-btn color="primary" :loading="totpBusy" @click="confirmEnable">
            {{ t("userSettings.totp.enable") }}
          </v-btn>
        </div>
      </div>

      <!-- Disabled state -->
      <div v-else class="d-flex">
        <v-spacer />
        <v-btn color="primary" :loading="totpBusy" @click="startEnable">{{ t("userSettings.totp.enable") }}</v-btn>
      </div>
      </v-card-text>
    </v-card>

    <!-- Disable dialog -->
    <v-dialog v-model="disableDialog" max-width="420">
      <v-card>
        <v-card-title>{{ t("userSettings.totp.disableTitle") }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 text-medium-emphasis mb-4">{{ t("userSettings.totp.disableHint") }}</p>
          <v-text-field
            v-model="disableCode"
            :label="t('userSettings.totp.disableCodeLabel')"
            autocomplete="one-time-code"
            density="comfortable"
            autofocus
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="totpBusy" @click="disableDialog = false">{{ t("common.cancel") }}</v-btn>
          <v-btn color="error" variant="flat" :loading="totpBusy" @click="confirmDisable">
            {{ t("userSettings.totp.disable") }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
