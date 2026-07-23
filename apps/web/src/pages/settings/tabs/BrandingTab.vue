<script setup lang="ts">
/**
 * Branding tab — GET/PATCH /v1/settings/branding. Owns *identity* (appName, logo,
 * theme-mode, shell chrome) and the three brand *colors*. The document header/
 * footer HTML live in the same branding group but are edited in the Document
 * Design tab; this tab loads and re-sends them untouched so a save here never
 * wipes them (both tabs PATCH the full BrandingSettings — last-save-wins on the
 * shared group).
 *
 * Colors live-preview by pushing into the running Vuetify theme immediately;
 * the branding store is also updated so appName/logo in the shell
 * reflect saves at once. Logo upload uses the files-storage flow.
 */
import { ref, computed, onMounted, inject } from "vue";
import { useI18n } from "vue-i18n";
import { useTheme } from "vuetify";
import { api, ApiError } from "@/api/client";
import type { BrandingSettings, ThemeModePref } from "@/types/domain";
import type { LocalizedText } from "@billy/shared/localized-text";
import { useBrandingStore, applyThemeColors, toApplied, normalizeHex } from "@/stores/branding";
import { uploadFile, logoUrlFor } from "@/api/files";
import { useFieldErrors } from "@/pages/settings/useFieldErrors";
import { SNACKBAR_KEY, NOOP_NOTIFY } from "@/pages/settings/snackbar";
import ColorInput from "@/components/ColorInput.vue";
import SettingsSection from "@/pages/settings/SettingsSection.vue";

const { t } = useI18n();
const theme = useTheme();
const branding = useBrandingStore();
const notify = inject(SNACKBAR_KEY, NOOP_NOTIFY);
const { fieldErrors, applyError, clear } = useFieldErrors();

const loading = ref(false);
const saving = ref(false);
const uploading = ref(false);
const errorMessage = ref<string | null>(null);

const appName = ref("");
const logoFileId = ref<string | null>(null);
const faviconFileId = ref<string | null>(null);
const primaryColor = ref("#5b5bd6");
const secondaryColor = ref("#6b7280");
const accentColor = ref("#8b8bf0");
const defaultThemeMode = ref<ThemeModePref>("system");
const loginBackground = ref<string | null>(null);
const supportEmail = ref<string | null>(null);
// Owned by the Document Design tab but part of the branding group — round-trip
// them untouched so a branding save doesn't clobber the document HTML.
// Owned/edited by the Document Design tab (now per-locale maps). BrandingTab
// only round-trips them untouched on save, so they're typed LocalizedText and
// passed through as-is — never coerced to a string, which would clobber a map.
const documentHeaderHtml = ref<LocalizedText>(null);
const documentFooterHtml = ref<LocalizedText>(null);

const themeModes = computed<{ title: string; value: ThemeModePref }[]>(() => [
  { title: t("settings.branding.themeSystem"), value: "system" },
  { title: t("settings.branding.themeLight"), value: "light" },
  { title: t("settings.branding.themeDark"), value: "dark" },
]);

const logoSrc = computed<string | null>(() =>
  logoFileId.value ? logoUrlFor(logoFileId.value) : null,
);
const faviconSrc = computed<string | null>(() =>
  faviconFileId.value ? logoUrlFor(faviconFileId.value) : null,
);
// loginBackground stores a fileId (new uploads) OR a raw URL (legacy/manual). A
// value with no scheme + no slash is treated as a fileId → resolve to its /content URL.
const loginBgSrc = computed<string | null>(() => {
  const v = loginBackground.value;
  if (!v) return null;
  return /^(https?:)?\/\//u.test(v) || v.startsWith("/") ? v : logoUrlFor(v);
});

const previewColors = (): void => {
  applyThemeColors(theme, {
    primaryColor: normalizeHex(primaryColor.value),
    secondaryColor: normalizeHex(secondaryColor.value),
    accentColor: normalizeHex(accentColor.value),
  });
};

const load = async (): Promise<void> => {
  loading.value = true;
  errorMessage.value = null;
  try {
    const b = await api.get<BrandingSettings>("/v1/settings/branding");
    appName.value = b.appName;
    logoFileId.value = b.logoFileId;
    faviconFileId.value = b.faviconFileId;
    primaryColor.value = b.primaryColor;
    secondaryColor.value = b.secondaryColor;
    accentColor.value = b.accentColor;
    defaultThemeMode.value = b.defaultThemeMode;
    loginBackground.value = b.loginBackground;
    supportEmail.value = b.supportEmail;
    documentHeaderHtml.value = b.documentHeaderHtml;
    documentFooterHtml.value = b.documentFooterHtml;
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.branding.loadError")} (${err.code})` : t("settings.branding.loadError");
  } finally {
    loading.value = false;
  }
};

const onLogoSelected = async (files: File | File[]): Promise<void> => {
  const file = Array.isArray(files) ? files[0] : files;
  if (!file) return;
  uploading.value = true;
  errorMessage.value = null;
  try {
    logoFileId.value = await uploadFile(file);
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.branding.saveError")} (${err.code})` : t("settings.branding.saveError");
  } finally {
    uploading.value = false;
  }
};

const onFaviconSelected = async (files: File | File[]): Promise<void> => {
  const file = Array.isArray(files) ? files[0] : files;
  if (!file) return;
  uploading.value = true;
  errorMessage.value = null;
  try {
    faviconFileId.value = await uploadFile(file);
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.branding.saveError")} (${err.code})` : t("settings.branding.saveError");
  } finally {
    uploading.value = false;
  }
};

/** Upload the login-page background image → stores its fileId. */
const onLoginBgSelected = async (files: File | File[]): Promise<void> => {
  const file = Array.isArray(files) ? files[0] : files;
  if (!file) return;
  uploading.value = true;
  errorMessage.value = null;
  try {
    loginBackground.value = await uploadFile(file);
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.branding.saveError")} (${err.code})` : t("settings.branding.saveError");
  } finally {
    uploading.value = false;
  }
};

const save = async (): Promise<void> => {
  clear();
  errorMessage.value = null;
  saving.value = true;
  const payload: BrandingSettings = {
    appName: appName.value,
    logoFileId: logoFileId.value,
    faviconFileId: faviconFileId.value,
    primaryColor: normalizeHex(primaryColor.value),
    secondaryColor: normalizeHex(secondaryColor.value),
    accentColor: normalizeHex(accentColor.value),
    defaultThemeMode: defaultThemeMode.value,
    loginBackground: loginBackground.value,
    supportEmail: supportEmail.value,
    documentHeaderHtml: documentHeaderHtml.value,
    documentFooterHtml: documentFooterHtml.value,
  };
  try {
    const saved = await api.patch<BrandingSettings>("/v1/settings/branding", payload);
    // Reflect immediately in the shell (appName/logo) + theme.
    branding.apply(theme, toApplied(saved));
    notify(t("settings.branding.saved"));
  } catch (err) {
    applyError(err);
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.branding.saveError")} (${err.code})` : t("settings.branding.saveError");
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
      <!-- Identity: app name + logo + theme mode -->
      <SettingsSection first :title="t('settings.branding.identity')" :hint="t('settings.branding.identityHint')">
        <v-row dense>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="appName"
              :label="t('settings.branding.appName')"
              :error-messages="fieldErrors.appName"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-select
              v-model="defaultThemeMode"
              :label="t('settings.branding.themeMode')"
              :items="themeModes"
              item-title="title"
              item-value="value"
              :error-messages="fieldErrors.defaultThemeMode"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-file-input
              :label="t('settings.branding.logo')"
              accept="image/*"
              prepend-icon="mdi-image-outline"
              :loading="uploading"
              density="comfortable"
              hide-details
              @update:model-value="onLogoSelected"
            />
          </v-col>
          <v-col cols="12" md="6" class="d-flex align-center">
            <v-sheet
              v-if="logoSrc"
              border
              rounded="lg"
              class="pa-2 d-inline-flex align-center justify-center"
              color="surface"
            >
              <v-img :src="logoSrc" max-height="48" max-width="180" :alt="t('settings.branding.logoPreview')" />
            </v-sheet>
          </v-col>

          <!-- App ICON — doubles as the browser favicon. -->
          <v-col cols="12" md="6">
            <v-file-input
              :label="t('settings.branding.icon')"
              accept="image/*"
              prepend-icon="mdi-shape-outline"
              :loading="uploading"
              density="comfortable"
              hide-details
              :hint="t('settings.branding.iconHint')"
              persistent-hint
              @update:model-value="onFaviconSelected"
            />
          </v-col>
          <v-col cols="12" md="6" class="d-flex align-center">
            <v-sheet
              v-if="faviconSrc"
              border
              rounded="lg"
              class="pa-2 d-inline-flex align-center justify-center"
              color="surface"
            >
              <v-img :src="faviconSrc" max-height="48" max-width="48" :alt="t('settings.branding.icon')" />
            </v-sheet>
          </v-col>
        </v-row>
      </SettingsSection>

      <!-- Colors: the three ColorInputs with live swatches -->
      <SettingsSection :title="t('settings.branding.colors')" :hint="t('settings.branding.colorsHint')">
        <v-row dense>
          <v-col cols="12" md="4">
            <ColorInput
              v-model="primaryColor"
              :label="t('settings.branding.primaryColor')"
              @update:model-value="previewColors"
            />
            <div v-if="fieldErrors.primaryColor" class="text-error text-caption px-3">
              {{ fieldErrors.primaryColor }}
            </div>
          </v-col>
          <v-col cols="12" md="4">
            <ColorInput
              v-model="secondaryColor"
              :label="t('settings.branding.secondaryColor')"
              @update:model-value="previewColors"
            />
            <div v-if="fieldErrors.secondaryColor" class="text-error text-caption px-3">
              {{ fieldErrors.secondaryColor }}
            </div>
          </v-col>
          <v-col cols="12" md="4">
            <ColorInput
              v-model="accentColor"
              :label="t('settings.branding.accentColor')"
              @update:model-value="previewColors"
            />
            <div v-if="fieldErrors.accentColor" class="text-error text-caption px-3">
              {{ fieldErrors.accentColor }}
            </div>
          </v-col>
        </v-row>
      </SettingsSection>

      <!-- Shell / auth chrome -->
      <SettingsSection>
        <v-row dense>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="supportEmail"
              :label="t('settings.branding.supportEmail')"
              type="email"
              :error-messages="fieldErrors.supportEmail"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-file-input
              :label="t('settings.branding.loginBackground')"
              accept="image/*"
              prepend-icon="mdi-image-outline"
              :loading="uploading"
              density="comfortable"
              :hint="t('settings.branding.loginBackgroundHint')"
              persistent-hint
              :error-messages="fieldErrors.loginBackground"
              clearable
              @update:model-value="onLoginBgSelected"
              @click:clear="loginBackground = null"
            />
          </v-col>
          <v-col cols="12" md="6" class="d-flex align-center">
            <v-sheet
              v-if="loginBgSrc"
              border
              rounded="lg"
              class="pa-2 d-inline-flex align-center justify-center"
              color="surface"
            >
              <v-img :src="loginBgSrc" max-height="48" max-width="120" :alt="t('settings.branding.loginBackground')" />
            </v-sheet>
          </v-col>
        </v-row>
      </SettingsSection>

      <div class="d-flex mt-2" style="gap: 12px">
        <v-spacer />
        <v-btn color="primary" type="submit" :loading="saving">{{ t("settings.branding.save") }}</v-btn>
      </div>
    </v-form>
    </v-card-text>
  </v-card>
</template>
