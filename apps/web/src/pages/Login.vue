<script setup lang="ts">
/**
 * Login page. Two-step: (1) email + password → the auth store returns either an
 * authenticated principal or a `2fa_required` challenge; (2) on a challenge, a
 * code step (6-digit TOTP or a backup code) completes sign-in. After auth we
 * redirect to the intended path (query `redirect`) or the dashboard — unless the
 * principal must change their password, in which case we route to User Settings
 * with a notice. Failed attempts map to friendly messages; raw server strings
 * are never shown.
 */
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuthStore } from "@/stores/auth";
import { ApiError } from "@/api/client";
import type { Principal } from "@/types/domain";

const { t } = useI18n();
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const email = ref("");
const password = ref("");
const showPassword = ref(false);
const loading = ref(false);
const errorMessage = ref<string | null>(null);

// 2FA step state. When `pendingToken` is set the code step is shown.
const step = ref<"credentials" | "twoFactor">("credentials");
const pendingToken = ref<string | null>(null);
const code = ref("");
// The code is EITHER a 6-digit TOTP (segmented v-otp-input) OR a longer backup
// code (a free-text field). Default to the TOTP entry; a toggle swaps to backup.
const useBackupCode = ref(false);
const expired = ref(false);
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

const messageForError = (err: unknown): string => {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "INVALID_CREDENTIALS":
        return step.value === "twoFactor" ? t("login.errors.invalidCode") : t("login.errors.invalidCredentials");
      case "RATE_LIMITED":
        return t("login.errors.rateLimited");
      case "TWO_FACTOR_REQUIRED":
        return t("login.errors.twoFactorRequired");
      default:
        return t("login.errors.generic");
    }
  }
  return t("login.errors.generic");
};

/** Route to the app after a resolved principal, honoring mustChangePassword. */
const finishLogin = async (principal: Principal): Promise<void> => {
  if (principal.mustChangePassword) {
    await router.push({ path: "/settings/customization", query: { mustChangePassword: "1" } });
    return;
  }
  const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "/";
  await router.push(redirect);
};

const startExpiry = (expiresInMs: number): void => {
  if (expiryTimer) clearTimeout(expiryTimer);
  expired.value = false;
  expiryTimer = setTimeout(() => {
    expired.value = true;
  }, expiresInMs);
};

const backToCredentials = (): void => {
  step.value = "credentials";
  pendingToken.value = null;
  code.value = "";
  useBackupCode.value = false;
  expired.value = false;
  errorMessage.value = null;
  if (expiryTimer) clearTimeout(expiryTimer);
};

/** Swap between the segmented TOTP input and the free-text backup-code field. */
const toggleBackupCode = (): void => {
  useBackupCode.value = !useBackupCode.value;
  code.value = "";
  errorMessage.value = null;
};

const onSubmitCredentials = async (): Promise<void> => {
  errorMessage.value = null;
  loading.value = true;
  try {
    const result = await auth.login({ email: email.value, password: password.value });
    if (result.status === "2fa_required") {
      pendingToken.value = result.pendingToken;
      step.value = "twoFactor";
      code.value = "";
      startExpiry(result.expiresInMs);
      return;
    }
    await finishLogin(result);
  } catch (err) {
    errorMessage.value = messageForError(err);
  } finally {
    loading.value = false;
  }
};

const onSubmitTwoFactor = async (): Promise<void> => {
  if (!pendingToken.value) return;
  if (expired.value) {
    errorMessage.value = t("login.errors.challengeExpired");
    return;
  }
  errorMessage.value = null;
  loading.value = true;
  try {
    const principal = await auth.verifyTwoFactor(pendingToken.value, code.value.trim());
    await finishLogin(principal);
  } catch (err) {
    errorMessage.value = messageForError(err);
  } finally {
    loading.value = false;
  }
};
</script>

<template>
  <v-app>
    <v-main>
      <main :aria-label="t('login.title')">
        <v-container class="fill-height" fluid>
          <v-row justify="center" align="center">
            <v-col cols="12" sm="8" md="5" lg="4">
              <v-card elevation="4" rounded="lg">
                <!-- Horizontal billy logo (icon + wordmark); no app-name text beside it. -->
                <div class="d-flex justify-center pt-8 pb-2 px-6">
                  <v-img src="/billy.png" alt="billy" :max-width="200" :max-height="64" contain />
                </div>
                <v-card-text class="px-6">
                  <v-alert
                    v-if="errorMessage"
                    type="error"
                    variant="tonal"
                    density="compact"
                    class="mb-4"
                    role="alert"
                  >
                    {{ errorMessage }}
                  </v-alert>

                  <!-- Step 1: credentials -->
                  <v-form v-if="step === 'credentials'" @submit.prevent="onSubmitCredentials">
                    <v-text-field
                      v-model="email"
                      :label="t('login.email')"
                      type="email"
                      autocomplete="username"
                      required
                      class="mb-2"
                    />
                    <v-text-field
                      v-model="password"
                      :label="t('login.password')"
                      :type="showPassword ? 'text' : 'password'"
                      :append-inner-icon="showPassword ? 'mdi-eye-off' : 'mdi-eye'"
                      autocomplete="current-password"
                      required
                      @click:append-inner="showPassword = !showPassword"
                    />
                    <v-btn
                      type="submit"
                      color="primary"
                      block
                      class="mt-4"
                      :loading="loading"
                      :disabled="loading"
                    >
                      {{ t("login.signIn") }}
                    </v-btn>
                  </v-form>

                  <!-- Step 2: 2FA code -->
                  <v-form v-else @submit.prevent="onSubmitTwoFactor">
                    <p class="text-body-2 text-medium-emphasis mb-4">
                      {{ t("login.twoFactor.hint") }}
                    </p>
                    <v-alert
                      v-if="expired"
                      type="warning"
                      variant="tonal"
                      density="compact"
                      class="mb-4"
                      role="alert"
                    >
                      {{ t("login.errors.challengeExpired") }}
                    </v-alert>
                    <!-- 6-digit TOTP: Vuetify's segmented OTP input (auto-advance,
                         paste, numeric). Backup codes are longer → free text. -->
                    <v-otp-input
                      v-if="!useBackupCode"
                      v-model="code"
                      :length="6"
                      type="number"
                      :disabled="loading || expired"
                      autofocus
                      class="mb-2"
                      @finish="onSubmitTwoFactor"
                    />
                    <v-text-field
                      v-else
                      v-model="code"
                      :label="t('login.twoFactor.backupCodeLabel')"
                      autocomplete="one-time-code"
                      inputmode="text"
                      autofocus
                      required
                    />
                    <div class="text-center">
                      <v-btn variant="text" size="small" :disabled="loading" @click="toggleBackupCode">
                        {{ useBackupCode ? t("login.twoFactor.useAppCode") : t("login.twoFactor.useBackupCode") }}
                      </v-btn>
                    </div>
                    <v-btn
                      type="submit"
                      color="primary"
                      block
                      class="mt-4"
                      :loading="loading"
                      :disabled="loading || expired"
                    >
                      {{ t("login.twoFactor.verify") }}
                    </v-btn>
                    <v-btn variant="text" block class="mt-2" :disabled="loading" @click="backToCredentials">
                      {{ t("login.twoFactor.back") }}
                    </v-btn>
                  </v-form>
                </v-card-text>
              </v-card>
            </v-col>
          </v-row>
        </v-container>
      </main>
    </v-main>
  </v-app>
</template>
