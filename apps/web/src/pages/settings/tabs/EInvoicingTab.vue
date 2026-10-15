<script setup lang="ts">
/**
 * E-invoicing (SdI) tab — GET/PATCH /v1/settings/einvoicing plus provision / channel
 * / test / reset. Not connected (or after a reset, or before the first "Finish"): the
 * stepped setup wizard. Connected: a status header (enable, test, reset) and every
 * expert section — setup guide, connection, transmission channel (managed mode),
 * fiscal profile, defaults & behaviour.
 *
 * SECURITY: the PASSO API key (manual mode) and the channel credentials are
 * WRITE-ONLY. They sit in refs that start blank, are sent only when typed, are
 * cleared after a successful save, and the view only ever carries `apiKeyLast4`.
 */
import { computed, inject, onMounted, ref } from "vue";
import { confirm } from "@/composables/useConfirm";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import { apiErrorReason } from "@/utils/validationMessages";
import type {
  BusinessSettings,
  EInvoicingSettings,
  EInvoicingSettingsUpdate,
  EInvoicingTestResult,
} from "@/types/domain";
import validations from "@/constants/validations";
import { useFormSubmit, type VuetifyFormRef } from "@/composables/useFormSubmit";
import { codeItems } from "@/utils/einvoicingCodes";
import { useEInvoicing } from "@/stores/einvoicing";
import { useFieldErrors } from "@/pages/settings/useFieldErrors";
import { SNACKBAR_KEY, NOOP_NOTIFY } from "@/pages/settings/snackbar";
import FormActions from "@/components/FormActions.vue";
import { useIsMobile } from "@/composables/useIsMobile";
import SettingsSection from "@/pages/settings/SettingsSection.vue";
import EInvoicingSetupGuide from "@/pages/settings/einvoicing/EInvoicingSetupGuide.vue";
import EInvoicingChannelForm from "@/pages/settings/einvoicing/EInvoicingChannelForm.vue";
import EInvoicingWizard from "@/pages/settings/einvoicing/EInvoicingWizard.vue";
import EInvoicingTestResultBox from "@/pages/settings/einvoicing/EInvoicingTestResult.vue";

const { t, te } = useI18n();
const notify = inject(SNACKBAR_KEY, NOOP_NOTIFY);
const isMobile = useIsMobile();
const einvoicing = useEInvoicing();
const { fieldErrors, applyError, clear } = useFieldErrors();

const view = ref<EInvoicingSettings | null>(null);
// Connection and defaults/fiscal profile are separate forms; each save validates first.
const connectionFormRef = ref<VuetifyFormRef | null>(null);
const defaultsFormRef = ref<VuetifyFormRef | null>(null);
const { submit: submitConnection } = useFormSubmit(connectionFormRef);
const { submit: submitDefaults } = useFormSubmit(defaultsFormRef);
const deadlineRules = validations.required.intBetween(1, 60);
const prefixRules = [validations.required.maxLength(8)];
const lawRules = [validations.maxLength(100)];
const business = ref<BusinessSettings | null>(null);
const loading = ref(false);
const saving = ref(false);
const resetting = ref(false);
/** True while the stepped setup is on screen (not connected / just reset / never finished). */
const wizardActive = ref(true);
/** Bumped on reset so the wizard remounts and re-derives its start step. */
const wizardKey = ref(0);
const testing = ref(false);
const errorMessage = ref<string | null>(null);
const testResult = ref<EInvoicingTestResult | null>(null);

// ── Editable form state (seeded from the view; secrets stay blank) ──────────────
const apiBaseUrl = ref("");
const mode = ref<"managed" | "manual">("manual");
/** Write-only (manual mode): blank means "leave the stored key unchanged". */
const apiKey = ref("");
const showApiKey = ref(false);
const passoSellerId = ref("");
const taxRegime = ref("RF01");
const offerStepAfterFinalize = ref(true);
const scheduledDefaultSubmit = ref(false);
const recurringDefaultSubmit = ref(false);
const defaultPaymentConditions = ref<"TP01" | "TP02" | "TP03">("TP02");
const defaultPaymentMethod = ref("MP05");
const defaultZeroRateNature = ref<string | null>(null);
const zeroRateLawReference = ref("");
const bolloMode = ref<"auto" | "off">("auto");
const bolloThreshold = ref("77.47");
const bolloAmount = ref("2.00");
const creditNoteNumberPrefix = ref("NC");
const sendDeadlineDays = ref<number | null>(12);

const adopt = (v: EInvoicingSettings): void => {
  view.value = v;
  einvoicing.applyView(v);
  apiBaseUrl.value = v.apiBaseUrl ?? v.envApiUrl ?? "";
  // Managed is only offered when the server holds the admin key.
  mode.value = v.mode === "managed" && !v.adminKeyAvailable ? "manual" : v.mode;
  passoSellerId.value = v.passoSellerId ?? "";
  taxRegime.value = v.taxRegime;
  offerStepAfterFinalize.value = v.offerStepAfterFinalize;
  scheduledDefaultSubmit.value = v.scheduledDefaultSubmit;
  recurringDefaultSubmit.value = v.recurringDefaultSubmit;
  defaultPaymentConditions.value = v.defaultPaymentConditions;
  defaultPaymentMethod.value = v.defaultPaymentMethod;
  defaultZeroRateNature.value = v.defaultZeroRateNature;
  zeroRateLawReference.value = v.zeroRateLawReference ?? "";
  bolloMode.value = v.bollo.mode;
  bolloThreshold.value = v.bollo.threshold;
  bolloAmount.value = v.bollo.amount;
  creditNoteNumberPrefix.value = v.creditNoteNumberPrefix;
  sendDeadlineDays.value = v.sendDeadlineDays;
};

const load = async (silent = false): Promise<void> => {
  // A silent reload (wizard "re-check") keeps the wizard mounted, so its step survives.
  loading.value = !silent;
  errorMessage.value = null;
  try {
    const v = await api.get<EInvoicingSettings>("/v1/settings/einvoicing");
    adopt(v);
    // First paint: connected, or already finished once → expert view; otherwise the wizard.
    if (!silent) wizardActive.value = !v.connected || (!v.enabled && v.enabledAt === null);
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError ? `${t("einvoicing.loadError")}: ${apiErrorReason(err)}` : t("einvoicing.loadError");
  } finally {
    loading.value = false;
  }
  // The read-only business summary is best effort.
  try {
    business.value = await api.get<BusinessSettings>("/v1/settings/business");
  } catch {
    business.value = null;
  }
};

const failure = (err: unknown, fallbackKey: string): string =>
  err instanceof ApiError ? `${t(fallbackKey)}: ${apiErrorReason(err)}` : t(fallbackKey);

/** PATCH a partial; adopts the returned view. Returns whether it succeeded. */
const patch = async (body: EInvoicingSettingsUpdate, okKey = "einvoicing.saved"): Promise<boolean> => {
  clear();
  errorMessage.value = null;
  saving.value = true;
  try {
    adopt(await api.patch<EInvoicingSettings>("/v1/settings/einvoicing", body));
    apiKey.value = ""; // write-only: gone as soon as it was sent
    notify(t(okKey));
    return true;
  } catch (err) {
    applyError(err);
    errorMessage.value = failure(err, "einvoicing.saveError");
    return false;
  } finally {
    saving.value = false;
  }
};

// ── Enable ───────────────────────────────────────────────────────────────────
const pendingKeys = computed<string[]>(() => (view.value?.readiness ?? []).filter((r) => !r.ok).map((r) => r.key));
const pendingNames = computed<string>(() =>
  pendingKeys.value.map((k) => (te(`einvoicing.readiness.${k}`) ? t(`einvoicing.readiness.${k}`) : k)).join(", "),
);

const setEnabled = async (value: boolean | null): Promise<void> => {
  await patch({ enabled: value === true });
};

// ── Connection ───────────────────────────────────────────────────────────────
// Managed is offered ONLY when the server holds the PASSO admin key.
const modeItems = computed(() => [
  ...(view.value?.adminKeyAvailable ? [{ title: t("einvoicing.connection.modes.managed"), value: "managed" }] : []),
  { title: t("einvoicing.connection.modes.manual"), value: "manual" },
]);

const saveConnection = async (): Promise<void> => {
  const body: EInvoicingSettingsUpdate = { mode: mode.value, apiBaseUrl: apiBaseUrl.value.trim() || null };
  if (mode.value === "manual") {
    if (apiKey.value.length > 0) body.apiKey = apiKey.value;
    if (passoSellerId.value.trim()) body.passoSellerId = passoSellerId.value.trim();
  }
  await patch(body, "einvoicing.connection.saved");
};

// ── Reset ────────────────────────────────────────────────────────────────────
const resetConnection = async (): Promise<void> => {
  const yes = await confirm({
    title: t("einvoicing.reset.title"),
    message: t("einvoicing.reset.message"),
    confirmText: t("einvoicing.reset.confirm"),
    tone: "error",
  });
  if (!yes) return;
  resetting.value = true;
  errorMessage.value = null;
  try {
    adopt(await api.post<EInvoicingSettings>("/v1/settings/einvoicing/reset"));
    testResult.value = null;
    apiKey.value = "";
    wizardKey.value += 1;
    wizardActive.value = true;
    notify(t("einvoicing.reset.done"));
  } catch (err) {
    notify(failure(err, "einvoicing.reset.error"));
  } finally {
    resetting.value = false;
  }
};

const onWizardUpdated = (v: EInvoicingSettings): void => adopt(v);

const testConnection = async (): Promise<void> => {
  testing.value = true;
  testResult.value = null;
  errorMessage.value = null;
  try {
    testResult.value = await api.post<EInvoicingTestResult>("/v1/settings/einvoicing/test");
    // The server records the health check on the view — pick it up.
    adopt(await api.get<EInvoicingSettings>("/v1/settings/einvoicing"));
  } catch (err) {
    errorMessage.value = failure(err, "einvoicing.connection.testError");
  } finally {
    testing.value = false;
  }
};

// ── Fiscal profile + defaults ────────────────────────────────────────────────
const regimeItems = computed(() => codeItems(t, "taxRegime"));
const methodItems = computed(() => codeItems(t, "paymentMethod"));
const conditionItems = computed(() => codeItems(t, "paymentCondition"));
const natureItems = computed(() => codeItems(t, "natura"));
const bolloModeItems = computed(() => [
  { title: t("einvoicing.defaults.bolloAuto"), value: "auto" },
  { title: t("einvoicing.defaults.bolloOff"), value: "off" },
]);

/** Business fields the seller section needs, each with a done/missing flag. */
const businessRows = computed(() => {
  const b = business.value;
  const name = b?.legalName || b?.businessName || "";
  const a = b?.address;
  const addressLine = a ? [a.line1, [a.postalCode, a.city].filter(Boolean).join(" "), a.region].filter(Boolean).join(", ") : "";
  return [
    { key: "name", value: name, ok: name.trim() !== "" },
    { key: "vat", value: b?.vatNumber ?? "", ok: !!b?.vatNumber?.trim() },
    { key: "taxCode", value: b?.taxCode ?? "", ok: !!b?.taxCode?.trim() },
    { key: "address", value: addressLine, ok: !!a && !!a.line1?.trim() && !!a.city?.trim() && !!a.postalCode?.trim() },
    { key: "province", value: a?.region ?? "", ok: /^[A-Za-z]{2}$/u.test(a?.region?.trim() ?? "") },
  ];
});

const saveDefaults = async (): Promise<void> => {
  await patch({
    taxRegime: taxRegime.value,
    offerStepAfterFinalize: offerStepAfterFinalize.value,
    scheduledDefaultSubmit: scheduledDefaultSubmit.value,
    recurringDefaultSubmit: recurringDefaultSubmit.value,
    defaultPaymentConditions: defaultPaymentConditions.value,
    defaultPaymentMethod: defaultPaymentMethod.value,
    defaultZeroRateNature: defaultZeroRateNature.value,
    zeroRateLawReference: zeroRateLawReference.value.trim() || null,
    bollo: { mode: bolloMode.value, threshold: bolloThreshold.value.trim(), amount: bolloAmount.value.trim() },
    creditNoteNumberPrefix: creditNoteNumberPrefix.value.trim(),
    sendDeadlineDays: Number(sendDeadlineDays.value),
  });
};

const onChannelSaved = (v: EInvoicingSettings): void => adopt(v);

const fmtDate = (iso: string | null | undefined): string => (iso ? iso.replace("T", " ").slice(0, 16) : "—");

onMounted(() => void load());
</script>

<template>
  <v-card variant="outlined" rounded="lg" :class="{ 'settings-bare': isMobile }" data-test="einvoicing-tab">
    <v-card-text>
      <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
        {{ errorMessage }}
      </v-alert>

      <div v-if="loading || !view" class="pa-8 text-center">
        <v-progress-circular v-if="loading" indeterminate />
      </div>

      <!-- Not connected / after a reset / before the first finish: stepped setup. -->
      <EInvoicingWizard
        v-else-if="!view.connected || wizardActive"
        :key="wizardKey"
        :view="view"
        :vat-number="business?.vatNumber"
        @updated="onWizardUpdated"
        @recheck="load(true)"
        @finished="wizardActive = false"
      />

      <template v-else>
        <!-- 1. Status header: chips, enable, test, reset -->
        <v-card variant="tonal" rounded="lg" class="pa-4 mb-4" :class="{ 'einv-status--m': isMobile }" data-test="einvoicing-status-header">
          <div class="d-flex flex-wrap align-center" style="gap: 8px" data-test="einvoicing-status-chips">
            <v-chip size="small" color="success" variant="tonal" label>{{ t("einvoicing.connection.statusConnected") }}</v-chip>
            <v-chip v-if="view.channel" size="small" variant="tonal" label data-test="chip-channel">
              {{ t("einvoicing.status.channel", { type: t(`einvoicing.channel.types.${view.channel.type}`) }) }}
            </v-chip>
            <v-chip v-if="view.passoTenantId" size="small" variant="tonal" label :title="view.passoTenantId">
              {{ t("einvoicing.connection.tenant", { name: view.passoTenantName ?? view.passoTenantId }) }}
            </v-chip>
            <v-chip v-if="view.passoSellerId" size="small" variant="tonal" label :title="view.passoSellerId">
              {{ t("einvoicing.connection.seller", { name: view.passoSellerName ?? view.passoSellerId }) }}
            </v-chip>
            <v-chip v-if="view.apiKeyConfigured" size="small" variant="tonal" color="success" label data-test="chip-key">
              {{ t("einvoicing.connection.keyLast4", { last4: view.apiKeyLast4 ?? "" }) }}
            </v-chip>
            <v-chip size="small" variant="tonal" :color="view.webhook.mode === 'webhook' ? 'success' : 'info'" label data-test="chip-webhook">
              {{ view.webhook.mode === "webhook" ? t("einvoicing.connection.webhook") : t("einvoicing.connection.pollOnly") }}
            </v-chip>
            <v-chip v-if="view.lastHealth" size="small" variant="tonal" :color="view.lastHealth.ok ? 'success' : 'error'" label data-test="chip-health">
              {{ t("einvoicing.connection.lastCheck", { date: fmtDate(view.lastHealth.checkedAt) }) }}
            </v-chip>
          </div>
          <div v-if="view.webhook.mode === 'poll' && view.webhook.reason" class="text-caption text-medium-emphasis mt-1">
            {{ view.webhook.reason }}
          </div>

          <v-switch
            :model-value="view.enabled"
            color="primary"
            hide-details
            :loading="saving"
            :label="t('einvoicing.enable.label')"
            class="mt-2"
            data-test="einvoicing-enable"
            @update:model-value="setEnabled"
          />
          <v-alert
            v-if="!view.enabled && pendingKeys.length > 0"
            type="warning"
            variant="tonal"
            density="compact"
            class="mt-2"
            data-test="einvoicing-incomplete"
          >
            {{ t("einvoicing.enable.incomplete", { items: pendingNames }) }}
          </v-alert>
          <div v-if="view.enabled && view.enabledAt" class="text-caption text-medium-emphasis mt-1">
            {{ t("einvoicing.enable.since", { date: fmtDate(view.enabledAt) }) }}
          </div>

          <div class="d-flex flex-wrap mt-3" :class="{ 'einv-actions--m': isMobile }" style="gap: 12px">
            <v-btn variant="tonal" color="primary" prepend-icon="mdi-heart-pulse" :loading="testing" data-test="einvoicing-test" @click="testConnection">
              {{ t("einvoicing.connection.test") }}
            </v-btn>
            <v-spacer />
            <v-btn variant="outlined" color="error" prepend-icon="mdi-restart" :loading="resetting" data-test="einvoicing-reset" @click="resetConnection">
              {{ t("einvoicing.reset.button") }}
            </v-btn>
          </div>
          <EInvoicingTestResultBox v-if="testResult" :result="testResult" />
        </v-card>

        <!-- 2. Setup guide (progress summary + what the statuses mean) -->
        <div :class="isMobile ? 'mb-3' : 'my-4'">
          <EInvoicingSetupGuide :view="view" />
        </div>

        <!-- 3. Connection (expert: URL, mode, manual key rotate/replace, seller id) -->
        <SettingsSection :title="t('einvoicing.connection.title')" :hint="t('einvoicing.connection.hint')">
          <v-form ref="connectionFormRef" @submit.prevent>
          <v-row>
            <v-col cols="12" md="8">
              <v-text-field
                v-model="apiBaseUrl"
                :label="t('einvoicing.connection.apiUrl')"
                :rules="validations.required.serviceUrl"
                :error-messages="fieldErrors.apiBaseUrl"
                density="comfortable"
                data-test="einvoicing-api-url"
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-select
                v-model="mode"
                :items="modeItems"
                :label="t('einvoicing.connection.mode')"
                :rules="validations.required.any"
                :hint="view.adminKeyAvailable ? undefined : t('einvoicing.connection.managedUnavailable')"
                persistent-hint
                density="comfortable"
                data-test="einvoicing-mode"
              />
            </v-col>
          </v-row>

          <!-- Manual: key + seller id pasted from the PASSO operator. -->
          <v-row v-if="mode === 'manual'">
            <v-col cols="12" md="6">
              <v-text-field
                v-model="apiKey"
                :label="t('einvoicing.connection.apiKey')"
                :type="showApiKey ? 'text' : 'password'"
                autocomplete="new-password"
                :append-inner-icon="showApiKey ? 'mdi-eye-off' : 'mdi-eye'"
                :hint="view.apiKeyConfigured ? t('einvoicing.connection.keyStoredHint') : t('einvoicing.connection.keyUnsetHint')"
                persistent-hint
                :rules="view.apiKeyConfigured ? [] : validations.required.any"
                :error-messages="fieldErrors.apiKey"
                density="comfortable"
                data-test="einvoicing-api-key"
                @click:append-inner="showApiKey = !showApiKey"
              />
            </v-col>
            <v-col cols="12" md="6">
              <v-text-field
                v-model="passoSellerId"
                :label="t('einvoicing.connection.sellerId')"
                :rules="validations.required.any"
                :error-messages="fieldErrors.passoSellerId"
                density="comfortable"
                data-test="einvoicing-seller-id"
              />
            </v-col>
          </v-row>

          <FormActions class="mt-2">
            <v-btn color="primary" :loading="saving" data-test="einvoicing-save-connection" @click="submitConnection(saveConnection)">
              {{ t("einvoicing.connection.save") }}
            </v-btn>
          </FormActions>
          </v-form>
        </SettingsSection>

        <!-- 4. Channel (managed mode only) -->
        <SettingsSection v-if="mode === 'managed'" :class="{ 'mt-4': !isMobile }" :title="t('einvoicing.channel.title')" :hint="t('einvoicing.channel.hint')">
          <EInvoicingChannelForm :view="view" :vat-number="business?.vatNumber" @saved="onChannelSaved" />
        </SettingsSection>

        <!-- 5 + 6. Fiscal profile and defaults (one form, one validated save) -->
        <v-form ref="defaultsFormRef" @submit.prevent>
        <SettingsSection :class="{ 'mt-4': !isMobile }" :title="t('einvoicing.fiscal.title')" :hint="t('einvoicing.fiscal.hint')">
          <v-select
            v-model="taxRegime"
            :items="regimeItems"
            :label="t('einvoicing.fiscal.taxRegime')"
            :rules="validations.required.any"
            :error-messages="fieldErrors.taxRegime"
            density="comfortable"
            data-test="einvoicing-tax-regime"
          />
          <div class="text-caption text-medium-emphasis mb-1">{{ t("einvoicing.fiscal.businessTitle") }}</div>
          <div v-if="isMobile" class="einv-biz--m" data-test="einvoicing-business-summary">
            <div v-for="row in businessRows" :key="row.key" class="einv-biz--m__row" :data-test="`biz-${row.key}`">
              <v-icon :icon="row.ok ? 'mdi-check-circle' : 'mdi-close-circle'" :color="row.ok ? 'success' : 'error'" size="18" class="einv-biz--m__icon" />
              <div class="einv-biz--m__text">
                <div class="einv-biz--m__label">{{ t(`einvoicing.fiscal.business.${row.key}`) }}</div>
                <div class="einv-biz--m__value">{{ row.value || "—" }}</div>
              </div>
            </div>
          </div>
          <div v-else data-test="einvoicing-business-summary">
            <div v-for="row in businessRows" :key="row.key" class="d-flex align-center text-body-2" style="gap: 6px" :data-test="`biz-${row.key}`">
              <v-icon :icon="row.ok ? 'mdi-check-circle' : 'mdi-close-circle'" :color="row.ok ? 'success' : 'error'" size="small" />
              <span class="text-medium-emphasis" style="min-width: 120px">{{ t(`einvoicing.fiscal.business.${row.key}`) }}</span>
              <span>{{ row.value || "—" }}</span>
            </div>
          </div>
          <v-btn
            size="small"
            variant="text"
            color="primary"
            class="mt-1"
            prepend-icon="mdi-office-building-outline"
            :to="{ name: 'settings-customization', params: { tab: 'company' } }"
            data-test="einvoicing-company-link"
          >
            {{ t("einvoicing.fiscal.openCompany") }}
          </v-btn>
        </SettingsSection>

        <SettingsSection :class="{ 'mt-4': !isMobile }" :title="t('einvoicing.defaults.title')" :hint="t('einvoicing.defaults.hint')">
          <v-switch v-model="offerStepAfterFinalize" color="primary" hide-details density="compact" :label="t('einvoicing.defaults.offerStep')" data-test="einvoicing-offer-step" />
          <v-switch v-model="scheduledDefaultSubmit" color="primary" hide-details density="compact" :label="t('einvoicing.defaults.scheduled')" data-test="einvoicing-scheduled-default" />
          <v-switch v-model="recurringDefaultSubmit" color="primary" hide-details density="compact" :label="t('einvoicing.defaults.recurring')" data-test="einvoicing-recurring-default" />

          <v-row class="mt-2">
            <v-col cols="12" md="6">
              <v-select v-model="defaultPaymentConditions" :items="conditionItems" :label="t('einvoicing.defaults.paymentConditions')" :rules="validations.required.any" :error-messages="fieldErrors.defaultPaymentConditions" density="comfortable" />
            </v-col>
            <v-col cols="12" md="6">
              <v-select v-model="defaultPaymentMethod" :items="methodItems" :label="t('einvoicing.defaults.paymentMethod')" :rules="validations.required.any" :error-messages="fieldErrors.defaultPaymentMethod" density="comfortable" />
            </v-col>
            <v-col cols="12" md="6">
              <v-select v-model="defaultZeroRateNature" :items="natureItems" clearable :label="t('einvoicing.defaults.nature')" :hint="t('einvoicing.defaults.natureHint')" persistent-hint :error-messages="fieldErrors.defaultZeroRateNature" density="comfortable" />
            </v-col>
            <v-col cols="12" md="6">
              <v-text-field v-model="zeroRateLawReference" :label="t('einvoicing.defaults.lawReference')" :rules="lawRules" :error-messages="fieldErrors.zeroRateLawReference" density="comfortable" />
            </v-col>
            <v-col cols="12" md="4">
              <v-select v-model="bolloMode" :items="bolloModeItems" :label="t('einvoicing.defaults.bolloMode')" :rules="validations.required.any" density="comfortable" data-test="einvoicing-bollo-mode" />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field v-model="bolloThreshold" :label="t('einvoicing.defaults.bolloThreshold')" :disabled="bolloMode === 'off'" inputmode="decimal" :rules="validations.required.decimal2" :error-messages="fieldErrors['bollo.threshold']" density="comfortable" />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field v-model="bolloAmount" :label="t('einvoicing.defaults.bolloAmount')" :disabled="bolloMode === 'off'" inputmode="decimal" :rules="validations.required.decimal2" :error-messages="fieldErrors['bollo.amount']" density="comfortable" />
            </v-col>
            <v-col cols="12" md="6">
              <v-text-field v-model="creditNoteNumberPrefix" :label="t('einvoicing.defaults.creditNotePrefix')" :hint="t('einvoicing.defaults.creditNotePrefixHint')" persistent-hint :rules="prefixRules" :error-messages="fieldErrors.creditNoteNumberPrefix" density="comfortable" />
            </v-col>
            <v-col cols="12" md="6">
              <v-text-field v-model.number="sendDeadlineDays" type="number" min="1" max="60" :label="t('einvoicing.defaults.deadlineDays')" :hint="t('einvoicing.defaults.deadlineDaysHint')" persistent-hint :rules="deadlineRules" :error-messages="fieldErrors.sendDeadlineDays" density="comfortable" />
            </v-col>
          </v-row>

          <FormActions class="mt-2">
            <v-btn color="primary" :loading="saving" data-test="einvoicing-save-defaults" @click="submitDefaults(saveDefaults)">
              {{ t("einvoicing.defaults.save") }}
            </v-btn>
          </FormActions>
        </SettingsSection>
        </v-form>
      </template>
    </v-card-text>
  </v-card>
</template>

<style scoped>
/* ── Phone ─────────────────────────────────────────────────────────────── */
.einv-status--m {
  border-radius: 16px !important;
  padding: 14px !important;
}
.einv-actions--m > .v-spacer {
  display: none;
}
/* Side by side when both labels fit, else one full-width button per row. */
.einv-actions--m > .v-btn {
  flex: 1 1 170px;
  min-width: 0;
  height: 44px;
}
/* Long chips (account / issuer names) wrap instead of being clipped. */
.einv-status--m :deep(.v-chip) {
  height: auto;
  min-height: 24px;
  max-width: 100%;
  padding-top: 3px;
  padding-bottom: 3px;
  white-space: normal;
  overflow-wrap: anywhere;
}
.einv-biz--m {
  border: 1px solid var(--v-billy-border, #e2e4e9);
  border-radius: 12px;
  overflow: hidden;
}
.einv-biz--m__row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
}
.einv-biz--m__row + .einv-biz--m__row {
  border-top: 1px solid var(--v-billy-border, #e2e4e9);
}
.einv-biz--m__icon {
  margin-top: 2px;
}
.einv-biz--m__text {
  min-width: 0;
}
.einv-biz--m__label {
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.6));
}
.einv-biz--m__value {
  font-size: 0.875rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
</style>
