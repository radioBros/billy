<script setup lang="ts">
/**
 * First-time e-invoicing setup as a stepper: 1 company data, 2 connect (managed or
 * manual), 3 channel (managed only), 4 test, 5 finish. Shown while the tab is not
 * connected, after a reset, or until the very first "Finish". The start step is
 * derived from the settings view; forward navigation needs the current step to be
 * satisfied, backwards is always free.
 *
 * SECURITY: the manual API key is WRITE-ONLY — a blank ref, sent once, cleared at
 * once, never rendered (only `apiKeyLast4` ever shows).
 */
import { computed, inject, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import { apiErrorReason } from "@/utils/validationMessages";
import type { EInvoicingSettings, EInvoicingSettingsUpdate, EInvoicingTestResult } from "@/types/domain";
import validations from "@/constants/validations";
import { useFormSubmit, type VuetifyFormRef } from "@/composables/useFormSubmit";
import { codeItems } from "@/utils/einvoicingCodes";
import { SNACKBAR_KEY, NOOP_NOTIFY } from "@/pages/settings/snackbar";
import EInvoicingChannelForm from "@/pages/settings/einvoicing/EInvoicingChannelForm.vue";
import EInvoicingTestResultBox from "@/pages/settings/einvoicing/EInvoicingTestResult.vue";
import { useIsMobile } from "@/composables/useIsMobile";
import { useHideBottomNav } from "@/composables/useMobileChrome";

const props = defineProps<{ view: EInvoicingSettings; vatNumber?: string | null }>();
const emit = defineEmits<{ updated: [EInvoicingSettings]; recheck: []; finished: [] }>();

const { t, te } = useI18n();
const notify = inject(SNACKBAR_KEY, NOOP_NOTIFY);

type Step = 1 | 2 | 3 | 4 | 5;

const readinessOk = (key: string): boolean => props.view.readiness.find((r) => r.key === key)?.ok === true;
/** Only the `business` item blocks connecting (the transmitter code is fixed after
 *  provisioning); any other item that merely links to the Company tab (IBAN) must not. */
const businessIncomplete = computed<boolean>(() => !readinessOk("business"));
const ibanMissing = computed<boolean>(() => props.view.readiness.some((r) => r.key === "iban" && !r.ok));

// ── Mode + connection form (secrets stay blank) ─────────────────────────────────
const mode = ref<"managed" | "manual">(props.view.adminKeyAvailable ? "managed" : "manual");
const apiBaseUrl = ref(props.view.apiBaseUrl ?? props.view.envApiUrl ?? "");
const apiKey = ref("");
const showApiKey = ref(false);
const passoSellerId = ref(props.view.passoSellerId ?? "");

// Step 2 (connect) and step 5 (finish) each validate their own form before acting.
const connectFormRef = ref<VuetifyFormRef | null>(null);
const finishFormRef = ref<VuetifyFormRef | null>(null);
const { submit: submitConnect } = useFormSubmit(connectFormRef);
const { submit: submitFinish } = useFormSubmit(finishFormRef);

const connecting = ref(false);
const testing = ref(false);
const finishing = ref(false);
const errorMessage = ref<string | null>(null);
const missingFields = ref<string[]>([]);
const justConnected = ref(false);
const testResult = ref<EInvoicingTestResult | null>(null);

const taxRegime = ref(props.view.taxRegime);
const bolloMode = ref<"auto" | "off">(props.view.bollo.mode);
const offerStep = ref(props.view.offerStepAfterFinalize);
const enableNow = ref(true);

const regimeItems = computed(() => codeItems(t, "taxRegime"));
const bolloItems = computed(() => [
  { title: t("einvoicing.defaults.bolloAuto"), value: "auto" },
  { title: t("einvoicing.defaults.bolloOff"), value: "off" },
]);
const modeItems = computed(() => [
  ...(props.view.adminKeyAvailable ? [{ title: t("einvoicing.connection.modes.managed"), value: "managed" }] : []),
  { title: t("einvoicing.connection.modes.manual"), value: "manual" },
]);

// ── Step state ──────────────────────────────────────────────────────────────────
const channelNeeded = computed<boolean>(() => mode.value === "managed");

/** Start step from the view: not connected → 1/2; connected → 3 (no channel yet) / 4. */
const deriveStart = (): Step => {
  const v = props.view;
  if (!v.connected) return readinessOk("business") ? 2 : 1;
  if (v.mode === "managed" && v.channel === null) return 3;
  return 4;
};
const step = ref<Step>(deriveStart());

const testPassed = computed<boolean>(() => {
  const r = testResult.value;
  if (!r) return false;
  // A webhook that falls back to polling is fine.
  return r.checks.every((c) => c.ok || (c.key === "webhook" && props.view.webhook.mode === "poll"));
});

/** Whether the user may be on `s`: every earlier step is satisfied. */
const reachable = (s: Step): boolean => {
  if (s >= 2 && !readinessOk("business")) return false;
  if (s >= 3 && !props.view.connected) return false;
  if (s >= 4 && channelNeeded.value && props.view.channel === null) return false;
  if (s >= 5 && !testPassed.value) return false;
  return true;
};
const target = computed<Step>(() => (step.value === 2 && !channelNeeded.value ? 4 : step.value + 1) as Step);
/** Channel form reports an unsaved choice / untested edits: Next waits for a saved channel. */
const channelBlocked = ref(false);
const canNext = computed<boolean>(() => step.value < 5 && reachable(target.value) && !(step.value === 3 && channelNeeded.value && channelBlocked.value));

const next = (): void => {
  if (canNext.value) step.value = target.value;
};
const back = (): void => {
  if (step.value <= 1) return;
  step.value = (step.value === 4 && !channelNeeded.value ? 2 : step.value - 1) as Step;
};
const goto = (s: Step): void => {
  if (s <= step.value || reachable(s)) step.value = s;
};

// ── Actions ─────────────────────────────────────────────────────────────────────
const failure = (err: unknown, fallbackKey: string): string =>
  err instanceof ApiError ? `${t(fallbackKey)}: ${apiErrorReason(err)}` : t(fallbackKey);

const connect = async (): Promise<void> => {
  missingFields.value = [];
  errorMessage.value = null;
  connecting.value = true;
  try {
    // Persist mode + URL first so provisioning targets what the admin sees.
    emit("updated", await api.patch<EInvoicingSettings>("/v1/settings/einvoicing", { mode: "managed", apiBaseUrl: apiBaseUrl.value.trim() || null }));
    const v = await api.post<EInvoicingSettings>("/v1/settings/einvoicing/provision");
    emit("updated", v);
    justConnected.value = true;
    notify(t("einvoicing.connection.connected"));
    step.value = 3;
  } catch (err) {
    const code = err instanceof ApiError ? String(err.code) : "";
    if (code === "EINVOICE_BUSINESS_INCOMPLETE") {
      const d = (err as ApiError).details as { fields?: unknown } | undefined;
      missingFields.value = (Array.isArray(d?.fields) ? (d!.fields as unknown[]) : []).map(String);
      errorMessage.value = t("einvoicing.errors.businessIncomplete");
    } else if (code === "EINVOICE_ADMIN_KEY_MISSING") {
      errorMessage.value = t("einvoicing.errors.adminKeyMissing");
    } else if (code === "EINVOICE_PASSO_UNREACHABLE") {
      errorMessage.value = t("einvoicing.errors.unreachable");
    } else {
      errorMessage.value = failure(err, "einvoicing.connection.connectError");
    }
  } finally {
    connecting.value = false;
  }
};

const saveManual = async (): Promise<void> => {
  missingFields.value = [];
  errorMessage.value = null;
  connecting.value = true;
  try {
    const body: EInvoicingSettingsUpdate = { mode: "manual", apiBaseUrl: apiBaseUrl.value.trim() || null };
    if (apiKey.value.length > 0) body.apiKey = apiKey.value;
    if (passoSellerId.value.trim()) body.passoSellerId = passoSellerId.value.trim();
    const v = await api.patch<EInvoicingSettings>("/v1/settings/einvoicing", body);
    apiKey.value = ""; // write-only: gone as soon as it was sent
    emit("updated", v);
    if (v.connected) {
      justConnected.value = true;
      notify(t("einvoicing.connection.saved"));
      step.value = 4; // manual mode skips the channel step
    } else {
      errorMessage.value = t("einvoicing.wizard.connect.manualIncomplete");
    }
  } catch (err) {
    errorMessage.value = failure(err, "einvoicing.saveError");
  } finally {
    connecting.value = false;
  }
};

const runTest = async (): Promise<void> => {
  testing.value = true;
  testResult.value = null;
  errorMessage.value = null;
  try {
    testResult.value = await api.post<EInvoicingTestResult>("/v1/settings/einvoicing/test");
    emit("recheck"); // the server records the health check on the view
  } catch (err) {
    errorMessage.value = failure(err, "einvoicing.connection.testError");
  } finally {
    testing.value = false;
  }
};

const finish = async (): Promise<void> => {
  errorMessage.value = null;
  finishing.value = true;
  try {
    const v = await api.patch<EInvoicingSettings>("/v1/settings/einvoicing", {
      taxRegime: taxRegime.value,
      bollo: { mode: bolloMode.value, threshold: props.view.bollo.threshold, amount: props.view.bollo.amount },
      offerStepAfterFinalize: offerStep.value,
      enabled: enableNow.value,
    });
    emit("updated", v);
    notify(t("einvoicing.wizard.finish.done"));
    emit("finished");
  } catch (err) {
    errorMessage.value = failure(err, "einvoicing.saveError");
  } finally {
    finishing.value = false;
  }
};

const STEP_KEYS = ["company", "connect", "channel", "test", "finish"] as const;
const stepKey = (s: Step): string => STEP_KEYS[s - 1]!;

// ── Phone: compact segmented header + sticky Back/Next bar (owns the bottom edge) ──
const isMobile = useIsMobile();
useHideBottomNav(isMobile);
const ALL_STEPS: Step[] = [1, 2, 3, 4, 5];
/** Manual mode skips the channel step: it reads as done once passed. */
const segmentState = (s: Step): "done" | "active" | "todo" => (s === step.value ? "active" : s < step.value ? "done" : "todo");
const rootEl = ref<HTMLElement | null>(null);
watch(step, () => {
  if (!isMobile.value) return;
  void nextTick(() => {
    const top = rootEl.value?.getBoundingClientRect().top ?? 0;
    if (top < 0) window.scrollTo({ top: Math.max(0, window.scrollY + top - 72), behavior: "smooth" });
  });
});

const readinessName = (k: string): string => (te(`einvoicing.readiness.${k}`) ? t(`einvoicing.readiness.${k}`) : k);

defineExpose({ step, businessIncomplete, mode });
</script>

<template>
  <div ref="rootEl" data-test="einvoicing-wizard" :class="{ 'wiz-m': isMobile }">
    <div class="text-h6">{{ t("einvoicing.wizard.title") }}</div>
    <div class="text-body-2 text-medium-emphasis mb-3">{{ t("einvoicing.wizard.hint") }}</div>

    <v-alert v-if="justConnected && view.connected" type="success" variant="tonal" density="compact" class="mb-3" data-test="wizard-connected">
      <div class="font-weight-medium">{{ t("einvoicing.connection.connected") }}</div>
      <div class="d-flex flex-wrap mt-1" style="gap: 8px">
        <v-chip v-if="view.passoTenantId" size="small" variant="outlined" label :title="view.passoTenantId">{{ t("einvoicing.connection.tenant", { name: view.passoTenantName ?? view.passoTenantId }) }}</v-chip>
        <v-chip v-if="view.passoSellerId" size="small" variant="outlined" label :title="view.passoSellerId">{{ t("einvoicing.connection.seller", { name: view.passoSellerName ?? view.passoSellerId }) }}</v-chip>
        <v-chip v-if="view.apiKeyConfigured" size="small" variant="outlined" label data-test="chip-key">{{ t("einvoicing.connection.keyLast4", { last4: view.apiKeyLast4 ?? "" }) }}</v-chip>
      </div>
    </v-alert>

    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-3" role="alert" data-test="wizard-error">
      {{ errorMessage }}
      <v-virtual-scroll v-if="missingFields.length > 0" :items="missingFields" max-height="160" class="mt-1" data-test="missing-fields">
        <template #default="{ item }">
          <div>&bull; {{ item }}</div>
        </template>
      </v-virtual-scroll>
    </v-alert>

    <!-- Phone: segmented progress + the active step's title/hint (sticky). -->
    <div v-if="isMobile" class="wiz-m__head">
      <div class="wiz-m__segments" role="tablist" :aria-label="t('einvoicing.wizard.title')">
        <button
          v-for="s in ALL_STEPS"
          :key="s"
          type="button"
          role="tab"
          class="wiz-m__segment"
          :class="`is-${segmentState(s)}`"
          :aria-selected="s === step"
          :aria-label="t(`einvoicing.wizard.steps.${stepKey(s)}`)"
          :disabled="s > step && !reachable(s)"
          :data-test="`wizard-segment-${s}`"
          :data-state="s < step ? 'complete' : s === step ? 'active' : 'pending'"
          @click="goto(s)"
        />
      </div>
      <div class="wiz-m__label">
        <span class="wiz-m__num">{{ step }}</span>
        <div class="wiz-m__titles">
          <div class="wiz-m__title">{{ t(`einvoicing.wizard.steps.${stepKey(step)}`) }}</div>
          <div class="wiz-m__hint">{{ t(`einvoicing.wizard.stepHints.${stepKey(step)}`) }}</div>
        </div>
        <span class="wiz-m__counter">{{ t("formSteps.counter", { n: step, total: 5 }) }}</span>
      </div>
    </div>

    <v-stepper
      :model-value="step"
      flat
      hide-actions
      alt-labels
      class="wizard-stepper"
      :class="isMobile ? 'wizard-stepper--m' : 'border rounded-lg'"
      data-test="wizard-stepper"
    >
      <!-- Phone: hidden (not removed) — its items register the steps the window follows. -->
      <v-stepper-header class="wizard-stepper__header" :class="{ 'd-none': isMobile }">
        <template v-for="s in ([1, 2, 3, 4, 5] as Step[])" :key="s">
          <v-divider
            v-if="s > 1"
            :thickness="3"
            :color="s <= step ? 'primary' : undefined"
            :class="['wizard-stepper__divider', s <= step ? 'wizard-stepper__divider--done' : 'wizard-stepper__divider--pending']"
            :data-test="`wizard-divider-${s - 1}`"
            :data-done="s <= step ? 'true' : 'false'"
          />
          <v-stepper-item
            :value="s"
            :title="t(`einvoicing.wizard.steps.${stepKey(s)}`)"
            :subtitle="t(`einvoicing.wizard.stepHints.${stepKey(s)}`)"
            color="primary"
            :complete="s < step"
            complete-icon="mdi-check"
            edit-icon="mdi-check"
            :editable="s < step"
            :disabled="s > step && !reachable(s)"
            :class="['wizard-stepper__item', { 'wizard-stepper__item--active': s === step }]"
            :data-test="`wizard-step-${s}`"
            :data-state="s < step ? 'complete' : s === step ? 'active' : 'pending'"
            @click="goto(s)"
          />
        </template>
      </v-stepper-header>

      <v-stepper-window>
        <!-- 1. Company data -->
        <v-stepper-window-item :value="1">
          <div class="pa-4" data-test="wizard-pane-1">
            <p class="text-body-2 mb-3">{{ t("einvoicing.wizard.company.hint") }}</p>
            <div class="d-flex align-center mb-1" style="gap: 8px" data-test="wizard-check-business">
              <v-icon :icon="readinessOk('business') ? 'mdi-check-circle' : 'mdi-close-circle'" :color="readinessOk('business') ? 'success' : 'error'" size="small" />
              <span>{{ readinessName("business") }}</span>
              <v-chip size="x-small" variant="tonal" label>{{ t("einvoicing.wizard.company.required") }}</v-chip>
            </div>
            <div class="d-flex align-center mb-1" style="gap: 8px" data-test="wizard-check-iban">
              <v-icon :icon="ibanMissing ? 'mdi-alert-circle-outline' : 'mdi-check-circle'" :color="ibanMissing ? 'warning' : 'success'" size="small" />
              <span>{{ readinessName("iban") }}</span>
              <v-chip size="x-small" variant="tonal" label>{{ t("einvoicing.wizard.company.recommended") }}</v-chip>
            </div>
            <div v-if="ibanMissing" class="text-caption text-medium-emphasis mb-2" data-test="wizard-iban-hint">{{ t("einvoicing.wizard.company.ibanHint") }}</div>
            <div class="d-flex flex-wrap mt-3" style="gap: 8px">
              <v-btn variant="tonal" color="primary" prepend-icon="mdi-office-building-outline" :to="{ name: 'settings-customization', params: { tab: 'company' } }" data-test="einvoicing-company-link">
                {{ t("einvoicing.fiscal.openCompany") }}
              </v-btn>
              <v-btn variant="text" prepend-icon="mdi-refresh" data-test="wizard-recheck" @click="emit('recheck')">
                {{ t("einvoicing.wizard.company.recheck") }}
              </v-btn>
            </div>
          </div>
        </v-stepper-window-item>

        <!-- 2. Connect -->
        <v-stepper-window-item :value="2">
          <v-form class="pa-4" data-test="wizard-pane-2" ref="connectFormRef" @submit.prevent>
            <v-select
              v-model="mode"
              :items="modeItems"
              :label="t('einvoicing.connection.mode')"
              :rules="validations.required.any"
              :hint="view.adminKeyAvailable ? undefined : t('einvoicing.connection.managedUnavailable')"
              persistent-hint
              density="comfortable"
              class="mb-2"
              data-test="einvoicing-mode"
            />
            <v-text-field v-model="apiBaseUrl" :label="t('einvoicing.connection.apiUrl')" :rules="validations.required.serviceUrl" density="comfortable" data-test="einvoicing-api-url" />

            <template v-if="mode === 'managed'">
              <p class="text-body-2 mb-3">{{ t("einvoicing.wizard.connect.managedHint") }}</p>
              <v-alert v-if="businessIncomplete" type="warning" variant="tonal" density="compact" class="mb-2" data-test="connect-blocked">
                {{ t("einvoicing.connection.businessFirst") }}
              </v-alert>
              <v-btn
                color="primary"
                size="large"
                block
                prepend-icon="mdi-lan-connect"
                :loading="connecting"
                :disabled="businessIncomplete || !view.adminKeyAvailable"
                data-test="einvoicing-connect"
                @click="submitConnect(connect)"
              >
                {{ t("einvoicing.connection.connect") }}
              </v-btn>
            </template>

            <template v-else>
              <p class="text-body-2 mb-3">{{ t("einvoicing.wizard.connect.manualHint") }}</p>
              <v-row>
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
                    density="comfortable"
                    data-test="einvoicing-api-key"
                    @click:append-inner="showApiKey = !showApiKey"
                  />
                </v-col>
                <v-col cols="12" md="6">
                  <v-text-field v-model="passoSellerId" :label="t('einvoicing.connection.sellerId')" :rules="validations.required.any" density="comfortable" data-test="einvoicing-seller-id" />
                </v-col>
              </v-row>
              <v-btn color="primary" :loading="connecting" prepend-icon="mdi-content-save-outline" data-test="einvoicing-save-connection" @click="submitConnect(saveManual)">
                {{ t("einvoicing.connection.save") }}
              </v-btn>
            </template>
          </v-form>
        </v-stepper-window-item>

        <!-- 3. Channel -->
        <v-stepper-window-item :value="3">
          <div class="pa-4" data-test="wizard-pane-3">
            <template v-if="channelNeeded">
              <p class="text-body-2 mb-3">{{ t("einvoicing.channel.hint") }}</p>
              <EInvoicingChannelForm :view="view" :vat-number="vatNumber" @saved="(v) => emit('updated', v)" @blocked="(b) => (channelBlocked = b)" />
              <div v-if="view.channel === null" class="text-caption text-medium-emphasis mt-2">{{ t("einvoicing.wizard.channel.required") }}</div>
            </template>
            <v-alert v-else type="info" variant="tonal" density="compact" data-test="wizard-channel-manual">
              {{ t("einvoicing.wizard.channel.manualNote") }}
            </v-alert>
          </div>
        </v-stepper-window-item>

        <!-- 4. Test -->
        <v-stepper-window-item :value="4">
          <div class="pa-4" data-test="wizard-pane-4">
            <p class="text-body-2 mb-3">{{ t("einvoicing.wizard.test.hint") }}</p>
            <v-btn variant="tonal" color="primary" prepend-icon="mdi-heart-pulse" :loading="testing" data-test="einvoicing-test" @click="runTest">
              {{ t("einvoicing.connection.test") }}
            </v-btn>
            <EInvoicingTestResultBox v-if="testResult" :result="testResult" :ok="testPassed" />
          </div>
        </v-stepper-window-item>

        <!-- 5. Finish -->
        <v-stepper-window-item :value="5">
          <v-form class="pa-4" data-test="wizard-pane-5" ref="finishFormRef" @submit.prevent>
            <p class="text-body-2 mb-3">{{ t("einvoicing.wizard.finish.hint") }}</p>
            <v-row>
              <v-col cols="12" md="6">
                <v-select v-model="taxRegime" :items="regimeItems" :label="t('einvoicing.fiscal.taxRegime')" :rules="validations.required.any" density="comfortable" data-test="einvoicing-tax-regime" />
              </v-col>
              <v-col cols="12" md="6">
                <v-select v-model="bolloMode" :items="bolloItems" :label="t('einvoicing.defaults.bolloMode')" :rules="validations.required.any" density="comfortable" data-test="einvoicing-bollo-mode" />
              </v-col>
            </v-row>
            <v-switch v-model="offerStep" color="primary" hide-details density="compact" :label="t('einvoicing.defaults.offerStep')" data-test="einvoicing-offer-step" />
            <v-switch v-model="enableNow" color="primary" hide-details density="compact" :label="t('einvoicing.enable.label')" data-test="wizard-enable" />
            <v-btn v-if="!isMobile" class="mt-4" color="primary" size="large" :loading="finishing" prepend-icon="mdi-check" data-test="wizard-finish" @click="submitFinish(finish)">
              {{ enableNow ? t("einvoicing.wizard.finish.finishEnable") : t("einvoicing.wizard.finish.finishOnly") }}
            </v-btn>
          </v-form>
        </v-stepper-window-item>
      </v-stepper-window>

      <div v-if="!isMobile" class="d-flex pa-3" style="gap: 8px">
        <v-btn variant="text" :disabled="step === 1" data-test="wizard-back" @click="back">{{ t("einvoicing.wizard.back") }}</v-btn>
        <v-spacer />
        <v-btn v-if="step < 5" color="primary" variant="tonal" :disabled="!canNext" data-test="wizard-next" @click="next">{{ t("einvoicing.wizard.next") }}</v-btn>
      </div>
    </v-stepper>

    <!-- Phone: sticky Back / Next (the last step finishes from here). -->
    <div v-if="isMobile" class="wiz-m__bar">
      <v-btn
        v-if="step > 1"
        icon="mdi-chevron-left"
        variant="tonal"
        class="wiz-m__back"
        :aria-label="t('einvoicing.wizard.back')"
        data-test="wizard-back"
        @click="back"
      />
      <v-btn
        v-if="step < 5"
        color="primary"
        variant="flat"
        class="wiz-m__next"
        append-icon="mdi-chevron-right"
        :disabled="!canNext"
        data-test="wizard-next"
        @click="next"
      >
        {{ t("einvoicing.wizard.next") }}
      </v-btn>
      <v-btn
        v-else
        color="primary"
        variant="flat"
        class="wiz-m__next"
        prepend-icon="mdi-check"
        :loading="finishing"
        data-test="wizard-finish"
        @click="submitFinish(finish)"
      >
        {{ enableNow ? t("einvoicing.wizard.finish.finishEnable") : t("einvoicing.wizard.finish.finishOnly") }}
      </v-btn>
    </div>
  </div>
</template>

<style scoped>
.wizard-stepper :deep(.wizard-stepper__header) {
  background: rgba(var(--v-theme-primary), 0.04);
  box-shadow: none;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  padding: 8px;
}
.wizard-stepper :deep(.v-stepper-item__avatar.v-avatar) {
  transition:
    background-color 0.3s ease,
    transform 0.3s ease,
    box-shadow 0.3s ease;
}
.wizard-stepper :deep(.wizard-stepper__item--active .v-stepper-item__avatar.v-avatar) {
  transform: scale(1.12);
  box-shadow: 0 0 0 4px rgba(var(--v-theme-primary), 0.18);
}
.wizard-stepper :deep(.v-stepper-item__title) {
  font-weight: 500;
  line-height: 1.2;
}
.wizard-stepper :deep(.v-stepper-item__subtitle) {
  font-size: 0.75rem;
  white-space: normal;
  text-align: center;
}
.wizard-stepper :deep(.wizard-stepper__divider) {
  transition:
    border-color 0.3s ease,
    opacity 0.3s ease;
}
.wizard-stepper :deep(.wizard-stepper__divider--pending) {
  opacity: 0.6;
}
.wizard-stepper :deep(.wizard-stepper__divider--done) {
  opacity: 1;
}
/* ── Phone ─────────────────────────────────────────────────────────────── */
.wiz-m__head {
  position: sticky;
  top: var(--v-layout-top, 56px);
  z-index: 3;
  margin: 0 -12px 12px;
  padding: 10px 16px 12px;
  background: rgb(var(--v-theme-background));
  border-bottom: 1px solid var(--v-billy-border, rgba(0, 0, 0, 0.08));
}
.wiz-m__segments {
  display: flex;
  gap: 6px;
}
.wiz-m__segment {
  flex: 1 1 0;
  height: 6px;
  border: 0;
  padding: 0;
  border-radius: 3px;
  background: rgba(var(--v-theme-on-surface), 0.12);
  cursor: pointer;
  transition: background-color var(--billy-dur, 200ms) ease;
}
.wiz-m__segment:disabled {
  cursor: default;
}
.wiz-m__segment.is-done {
  background: rgba(var(--v-theme-primary), 0.5);
}
.wiz-m__segment.is-active {
  background: rgb(var(--v-theme-primary));
}
.wiz-m__label {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  min-width: 0;
}
.wiz-m__num {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8125rem;
  font-weight: 700;
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
}
.wiz-m__titles {
  flex: 1 1 auto;
  min-width: 0;
}
.wiz-m__title {
  font-weight: 700;
  font-size: 1rem;
  line-height: 1.25;
  letter-spacing: -0.01em;
}
.wiz-m__hint {
  font-size: 0.8125rem;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.6));
}
.wiz-m__counter {
  flex: 0 0 auto;
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.6));
}
.wizard-stepper--m {
  background: rgb(var(--v-theme-surface)) !important;
  border: 1px solid var(--v-billy-border, #e2e4e9) !important;
  border-radius: 16px !important;
  min-height: 40vh;
}
.wizard-stepper--m :deep(.v-stepper-window) {
  margin: 0;
}
.wiz-m__bar {
  position: sticky;
  bottom: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 16px -12px -24px;
  padding: 12px 12px calc(12px + env(safe-area-inset-bottom, 0px));
  background: rgb(var(--v-theme-surface));
  border-top: 1px solid var(--v-billy-border, rgba(0, 0, 0, 0.08));
}
.wiz-m__back {
  flex: 0 0 auto;
  width: 48px !important;
  height: 48px !important;
}
.wiz-m__next {
  flex: 1 1 auto;
  min-width: 0;
  height: 48px !important;
}
@media (max-width: 959px) {
  /* Narrow screens: only the active step keeps its text; the others collapse to the circle. */
  .wizard-stepper :deep(.v-stepper-item__subtitle) {
    display: none;
  }
  .wizard-stepper :deep(.wizard-stepper__item:not(.wizard-stepper__item--active) .v-stepper-item__content) {
    display: none;
  }
}
</style>
