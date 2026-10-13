<script setup lang="ts">
/**
 * Transmission-channel form (managed mode only): PEC mailbox or OpenAPI.it (or the
 * mock channel outside production). `PUT /v1/settings/einvoicing/channel`.
 *
 * SECURITY: credentials (PEC password, OpenAPI.it token) are WRITE-ONLY. They live
 * in refs that start blank, are sent once, forwarded by the API to PASSO (never
 * stored) and cleared right after the save — nothing secret is ever rendered back.
 * The OpenAPI.it `inboundWebhookUrl` returned by the save is shown once, with a
 * copy button, because the admin must paste it into the vendor console.
 */
import { computed, inject, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import { apiErrorReason } from "@/utils/validationMessages";
import { useAuthStore } from "@/stores/auth";
import validations from "@/constants/validations";
import { useFormSubmit, type VuetifyFormRef } from "@/composables/useFormSubmit";
import type { EInvoiceChannelType, EInvoicingChannelResult, EInvoicingSettings } from "@/types/domain";
import { useFieldErrors } from "@/pages/settings/useFieldErrors";
import { SNACKBAR_KEY, NOOP_NOTIFY } from "@/pages/settings/snackbar";
import EInvoicingOpenApiNotice from "@/pages/settings/einvoicing/EInvoicingOpenApiNotice.vue";

const props = defineProps<{ view: EInvoicingSettings; vatNumber?: string | null }>();
const emit = defineEmits<{ saved: [EInvoicingSettings]; blocked: [boolean] }>();

const { t } = useI18n();
const auth = useAuthStore();
const notify = inject(SNACKBAR_KEY, NOOP_NOTIFY);
const { fieldErrors, applyError, clear } = useFieldErrors();

/** Explicit choice: nothing is preselected until a channel has been saved. */
const channelType = ref<EInvoiceChannelType | null>(props.view.channel?.type ?? null);
const saving = ref(false);
const errorMessage = ref<string | null>(null);
const inboundWebhookUrl = ref<string | null>(null);

// One v-form per channel: every test / save action validates its form first so
// each empty or malformed field shows its error instead of hitting the API.
const pecFormRef = ref<VuetifyFormRef | null>(null);
const oaFormRef = ref<VuetifyFormRef | null>(null);
const { submit: submitPec } = useFormSubmit(pecFormRef);
const { submit: submitOa } = useFormSubmit(oaFormRef);
/** Clear leftover "required" errors on fields we blank on purpose (secrets after a save). */
const resetValidation = async (): Promise<void> => {
  await nextTick();
  for (const f of [pecFormRef.value, oaFormRef.value]) f?.resetValidation?.();
};

// PEC
const smtpHost = ref("");
const smtpPort = ref<number | null>(465);
const imapHost = ref("");
const imapPort = ref<number | null>(993);
const pecUser = ref("");
/** Write-only. */
const pecPassword = ref("");
// OpenAPI.it
/** Write-only. */
const token = ref("");
const BASE_URLS = { sandbox: "https://test.sdi.openapi.it", production: "https://sdi.openapi.it" } as const;
type OpenApiEnv = keyof typeof BASE_URLS;
const env = ref<OpenApiEnv>("sandbox");
const baseUrl = computed<string>(() => BASE_URLS[env.value]);
const requestSigning = ref(false);

// Prefill the NON-secret half from what the API echoes back as `publicConfig`.
const prefill = (): void => {
  const cfg = props.view.channel?.publicConfig ?? {};
  const str = (k: string): string => (typeof cfg[k] === "string" ? (cfg[k] as string) : "");
  const num = (k: string, d: number): number => (typeof cfg[k] === "number" ? (cfg[k] as number) : d);
  if (props.view.channel?.type === "pec") {
    smtpHost.value = str("smtpHost");
    smtpPort.value = num("smtpPort", 465);
    imapHost.value = str("imapHost");
    imapPort.value = num("imapPort", 993);
    pecUser.value = str("user");
  } else if (props.view.channel?.type === "openapi") {
    const saved = str("baseUrl");
    env.value = saved === "" || saved === "test" || saved.includes("test.") ? "sandbox" : "production";
    requestSigning.value = cfg.requestSigning === true;
  }
};
prefill();
watch(() => props.view.channel, prefill);

const baseUrlItems = computed(() => [
  { title: t("einvoicing.channel.openapi.sandbox"), value: "sandbox" },
  { title: t("einvoicing.channel.openapi.production"), value: "production" },
]);

interface ChannelCard {
  value: EInvoiceChannelType;
  icon: string;
  features: string[];
}
const cards = computed<ChannelCard[]>(() => [
  { value: "openapi", icon: "mdi-cloud-check-outline", features: ["f1", "f2", "f3"] },
  { value: "pec", icon: "mdi-email-lock-outline", features: ["f1", "f2"] },
  ...(props.view.mockAllowed ? [{ value: "mock" as const, icon: "mdi-flask-outline", features: ["f1"] }] : []),
]);
const choose = (v: EInvoiceChannelType): void => {
  channelType.value = v;
  errorMessage.value = null;
};

const buildConfig = (): Record<string, unknown> => {
  if (channelType.value === "pec") {
    return {
      smtpHost: smtpHost.value.trim(),
      smtpPort: Number(smtpPort.value),
      imapHost: imapHost.value.trim(),
      imapPort: Number(imapPort.value),
      user: pecUser.value.trim(),
      password: pecPassword.value,
    };
  }
  if (channelType.value === "openapi") {
    return { token: token.value, baseUrl: baseUrl.value, requestSigning: requestSigning.value };
  }
  return {};
};

// ── PEC connection test (forced before saving) ─────────────────────────────────
interface PecStep {
  ok: boolean;
  message?: string;
}
interface PecTestResult {
  ok: boolean;
  smtp: PecStep;
  imap: PecStep;
  mail: PecStep;
}

/** Where the test email goes; defaults to the signed-in user. NOT part of the tested config. */
const testTo = ref<string>(auth.principal?.email ?? "");
const testing = ref(false);
const testResult = ref<PecTestResult | null>(null);
const testedTo = ref("");
const testedKey = ref<string | null>(null);
const toError = ref<string | null>(null);

/** Fingerprint of every PEC field the server pins its test to (password included). */
const pecKey = computed<string>(() =>
  JSON.stringify([smtpHost.value.trim(), Number(smtpPort.value), imapHost.value.trim(), Number(imapPort.value), pecUser.value.trim(), pecPassword.value]),
);
const baselineKey = ref<string>(pecKey.value);
watch(() => props.view.channel, () => (baselineKey.value = pecKey.value), { flush: "post" });

const testPassed = computed<boolean>(() => testResult.value?.ok === true && testedKey.value === pecKey.value);
/** A result is on screen but the settings changed since: say why it no longer counts. */
const testStale = computed<boolean>(() => testResult.value !== null && testedKey.value !== pecKey.value);
/** Save (and the wizard's Next) stay locked while PEC is selected, edited and untested. */
const pecBlocked = computed<boolean>(
  () => channelType.value === "pec" && !testPassed.value && (pecKey.value !== baselineKey.value || testResult.value !== null || props.view.channel?.type !== "pec"),
);

// ── OpenAPI.it connection test (forced before saving, like PEC) ────────────────
interface OaCheck {
  key: "token" | "registry" | "signing";
  ok: boolean;
  message?: string;
}
interface OaTestResult {
  ok: boolean;
  checks: OaCheck[];
}
const oaTesting = ref(false);
const oaResult = ref<OaTestResult | null>(null);
const oaTestedKey = ref<string | null>(null);
/** Fingerprint of the three values the server pins its test to. */
const oaKey = computed<string>(() => JSON.stringify([token.value, baseUrl.value, requestSigning.value]));
const oaBaseline = ref<string>(oaKey.value);
watch(() => props.view.channel, () => (oaBaseline.value = oaKey.value), { flush: "post" });
const oaPassed = computed<boolean>(() => oaResult.value?.ok === true && oaTestedKey.value === oaKey.value);
const oaStale = computed<boolean>(() => oaResult.value !== null && oaTestedKey.value !== oaKey.value);
const oaBlocked = computed<boolean>(
  () => channelType.value === "openapi" && !oaPassed.value && (oaKey.value !== oaBaseline.value || oaResult.value !== null || props.view.channel?.type !== "openapi"),
);

const blocked = computed<boolean>(() => {
  if (channelType.value === null) return true;
  if (channelType.value === "pec") return pecBlocked.value;
  if (channelType.value === "openapi") return oaBlocked.value;
  return props.view.channel?.type !== channelType.value;
});
watch(blocked, (v) => emit("blocked", v), { immediate: true });
const saveLocked = computed<boolean>(() => {
  if (channelType.value === null) return true;
  if (channelType.value === "pec") return !testPassed.value;
  if (channelType.value === "openapi") return !oaPassed.value;
  return false;
});

const oaRows = computed(() => {
  const r = oaResult.value;
  if (!r) return [];
  const tok = token.value;
  return (["token", "registry", "signing"] as const).flatMap((key) => {
    const c = r.checks.find((x) => x.key === key);
    if (!c) return [];
    const raw = (c.message ?? "").trim();
    const detail = tok.length > 0 ? raw.split(tok).join("•••") : raw;
    return [{ key, ok: c.ok, label: t(`einvoicing.channel.openapi.rows.${key}`), remedy: c.ok ? "" : t(`einvoicing.channel.openapi.remedies.${key}`), detail: c.ok ? "" : detail }];
  });
});

const runOaTest = async (): Promise<void> => {
  errorMessage.value = null;
  const key = oaKey.value;
  oaTesting.value = true;
  oaResult.value = null;
  try {
    const res = await api.post<OaTestResult>("/v1/settings/einvoicing/channel/test-openapi", {
      config: { token: token.value, baseUrl: baseUrl.value, requestSigning: requestSigning.value },
    });
    oaResult.value = res;
    oaTestedKey.value = key;
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? `${t("einvoicing.channel.openapi.testError")}: ${apiErrorReason(err)}` : t("einvoicing.channel.openapi.testError");
  } finally {
    oaTesting.value = false;
  }
};

/** Plain-language reason for a server step message; unknown text is kept as-is, never with the password. */
const reason = (step: PecStep): string => {
  const raw = (step.message ?? "").trim();
  if (!raw) return "";
  const pw = pecPassword.value;
  const safe = pw.length > 0 ? raw.split(pw).join("•••") : raw;
  const known: [RegExp, string][] = [
    [/auth|login|credential|535|password|invalid user/iu, "authFailed"],
    [/ENOTFOUND|EAI_AGAIN|getaddrinfo|not found/iu, "hostNotFound"],
    [/ECONNREFUSED|ETIMEDOUT|ECONNRESET|timed? ?out|timeout|unreachable/iu, "unreachable"],
    [/cert|tls|ssl|handshake/iu, "tlsFailed"],
  ];
  for (const [re, key] of known) if (re.test(safe)) return t(`einvoicing.channel.pec.reasons.${key}`);
  return safe;
};

const rows = computed(() => {
  const r = testResult.value;
  if (!r) return [];
  return [
    { key: "smtp", ok: r.smtp.ok, label: t("einvoicing.channel.pec.rows.smtp"), reason: r.smtp.ok ? "" : reason(r.smtp) },
    { key: "imap", ok: r.imap.ok, label: t("einvoicing.channel.pec.rows.imap"), reason: r.imap.ok ? "" : reason(r.imap) },
    { key: "mail", ok: r.mail.ok, label: t("einvoicing.channel.pec.rows.mail", { to: testedTo.value }), reason: r.mail.ok ? "" : reason(r.mail) },
  ];
});

const runTest = async (): Promise<void> => {
  errorMessage.value = null;
  toError.value = null;
  const to = testTo.value.trim();
  if (!to) {
    toError.value = t("einvoicing.channel.pec.toRequired");
    return;
  }
  const key = pecKey.value;
  testing.value = true;
  testResult.value = null;
  try {
    const res = await api.post<PecTestResult>("/v1/settings/einvoicing/channel/test", { config: buildConfig(), to });
    testResult.value = res;
    testedTo.value = to;
    testedKey.value = key;
  } catch (err) {
    const d = err instanceof ApiError ? (err.details as { to?: unknown } | undefined) : undefined;
    if (d?.to === "pec.test_recipient_forbidden") toError.value = t("einvoicing.channel.pec.recipientForbidden");
    else if (d?.to !== undefined) toError.value = t("einvoicing.channel.pec.toInvalid");
    else errorMessage.value = err instanceof ApiError ? `${t("einvoicing.channel.pec.testError")}: ${apiErrorReason(err)}` : t("einvoicing.channel.pec.testError");
  } finally {
    testing.value = false;
  }
};

/** Save button: validates the active channel form first (mock has no fields). */
const saveChannel = async (): Promise<void> => {
  if (channelType.value === "pec") await submitPec(save);
  else if (channelType.value === "openapi") await submitOa(save);
  else await save();
};

const save = async (): Promise<void> => {
  if (channelType.value === null) return;
  clear();
  errorMessage.value = null;
  inboundWebhookUrl.value = null;
  saving.value = true;
  try {
    const res = await api.put<EInvoicingChannelResult>("/v1/settings/einvoicing/channel", {
      type: channelType.value,
      config: buildConfig(),
    });
    // Secrets leave memory immediately after a successful save.
    pecPassword.value = "";
    token.value = "";
    testResult.value = null;
    testedKey.value = null;
    baselineKey.value = pecKey.value;
    oaResult.value = null;
    oaTestedKey.value = null;
    oaBaseline.value = oaKey.value;
    inboundWebhookUrl.value = res.inboundWebhookUrl ?? null;
    emit("saved", res.view);
    notify(t("einvoicing.channel.saved"));
    void resetValidation();
  } catch (err) {
    applyError(err);
    const d = err instanceof ApiError ? (err.details as { channel?: unknown } | undefined) : undefined;
    errorMessage.value =
      d?.channel === "pec.test_required"
        ? t("einvoicing.channel.pec.testRequired")
        : d?.channel === "openapi.test_required"
          ? t("einvoicing.channel.openapi.testRequired")
          : err instanceof ApiError ? `${t("einvoicing.channel.saveError")}: ${apiErrorReason(err)}` : t("einvoicing.channel.saveError");
  } finally {
    saving.value = false;
  }
};

const copyUrl = async (): Promise<void> => {
  if (!inboundWebhookUrl.value) return;
  try {
    await navigator.clipboard.writeText(inboundWebhookUrl.value);
    notify(t("einvoicing.channel.copied"));
  } catch {
    // clipboard unavailable (insecure context): the URL is visible and selectable
  }
};
</script>

<template>
  <div data-test="einvoicing-channel-form">
    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-3" role="alert">
      {{ errorMessage }}
    </v-alert>

    <div v-if="view.channel" class="d-flex align-center mb-3" style="gap: 8px" data-test="channel-current">
      <v-chip size="small" color="success" variant="tonal" prepend-icon="mdi-check">
        {{ t("einvoicing.channel.current", { type: t(`einvoicing.channel.types.${view.channel.type}`) }) }}
      </v-chip>
      <span class="text-caption text-medium-emphasis">{{ view.channel.configuredAt.slice(0, 10) }}</span>
    </div>

    <div class="text-subtitle-2 mb-2">{{ t("einvoicing.channel.chooser.title") }}</div>
    <v-row role="radiogroup" :aria-label="t('einvoicing.channel.type')" class="mb-1" data-test="channel-chooser">
      <v-col v-for="c in cards" :key="c.value" cols="12" :sm="cards.length > 2 ? 4 : 6">
        <v-card
          :variant="channelType === c.value ? 'tonal' : 'outlined'"
          :color="channelType === c.value ? 'primary' : undefined"
          rounded="lg"
          class="channel-card h-100"
          :class="{ 'channel-card--selected': channelType === c.value }"
          role="radio"
          tabindex="0"
          :aria-checked="channelType === c.value ? 'true' : 'false'"
          :data-test="`channel-card-${c.value}`"
          :data-selected="channelType === c.value ? 'true' : 'false'"
          @click="choose(c.value)"
          @keydown.enter.prevent="choose(c.value)"
          @keydown.space.prevent="choose(c.value)"
        >
          <v-card-text class="pa-4">
            <div class="d-flex align-center mb-1" style="gap: 10px">
              <v-avatar :color="channelType === c.value ? 'primary' : undefined" :variant="channelType === c.value ? 'flat' : 'tonal'" size="36">
                <v-icon :icon="c.icon" size="small" />
              </v-avatar>
              <div class="text-subtitle-1 font-weight-medium flex-grow-1 channel-card__title">{{ t(`einvoicing.channel.types.${c.value}`) }}</div>
            </div>
            <!-- Absolutely positioned so selecting a card never changes its layout. -->
            <v-icon v-if="channelType === c.value" icon="mdi-check-circle" color="primary" class="channel-card__check" :data-test="`channel-card-${c.value}-check`" />
            <div class="text-body-2 mb-2">{{ t(`einvoicing.channel.cards.${c.value}.subtitle`) }}</div>
            <div v-for="f in c.features" :key="f" class="d-flex align-start text-caption" style="gap: 6px">
              <v-icon icon="mdi-check" size="x-small" class="mt-1" />
              <span>{{ t(`einvoicing.channel.cards.${c.value}.${f}`) }}</span>
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
    <div v-if="channelType === null" class="text-caption text-medium-emphasis mb-2" data-test="channel-choose-hint">
      {{ t("einvoicing.channel.chooser.pick") }}
    </div>

    <v-alert v-if="channelType === 'pec'" type="info" variant="tonal" density="comfortable" rounded="lg" icon="mdi-information-outline" class="mt-2 mb-3" data-test="pec-notice">
      <div class="font-weight-medium mb-1">{{ t("einvoicing.channel.pec.noticeTitle") }}</div>
      <div class="text-body-2">{{ t("einvoicing.channel.pec.notice") }}</div>
    </v-alert>

    <v-form v-if="channelType === 'pec'" ref="pecFormRef" data-test="pec-form" @submit.prevent>
    <v-row>
      <v-col cols="12" md="8">
        <v-text-field v-model="smtpHost" :label="t('einvoicing.channel.pec.smtpHost')" :rules="validations.required.host" :error-messages="fieldErrors['config.smtpHost']" density="comfortable" data-test="pec-smtp-host" />
      </v-col>
      <v-col cols="12" md="4">
        <v-text-field v-model.number="smtpPort" :label="t('einvoicing.channel.pec.smtpPort')" type="number" :rules="validations.required.port" :error-messages="fieldErrors['config.smtpPort']" density="comfortable" data-test="pec-smtp-port" />
      </v-col>
      <v-col cols="12" md="8">
        <v-text-field v-model="imapHost" :label="t('einvoicing.channel.pec.imapHost')" :rules="validations.required.host" :error-messages="fieldErrors['config.imapHost']" density="comfortable" data-test="pec-imap-host" />
      </v-col>
      <v-col cols="12" md="4">
        <v-text-field v-model.number="imapPort" :label="t('einvoicing.channel.pec.imapPort')" type="number" :rules="validations.required.port" :error-messages="fieldErrors['config.imapPort']" density="comfortable" data-test="pec-imap-port" />
      </v-col>
      <v-col cols="12" md="6">
        <v-text-field v-model="pecUser" :label="t('einvoicing.channel.pec.user')" autocomplete="off" :rules="validations.required.any" :error-messages="fieldErrors['config.user']" density="comfortable" data-test="pec-user" />
      </v-col>
      <v-col cols="12" md="6">
        <v-text-field
          v-model="pecPassword"
          :label="t('einvoicing.channel.pec.password')"
          type="password"
          autocomplete="new-password"
          :hint="t('einvoicing.channel.secretHint')"
          persistent-hint
          :rules="validations.required.any"
          :error-messages="fieldErrors['config.password']"
          density="comfortable"
          data-test="channel-pec-password"
        />
      </v-col>
    </v-row>

    <div class="rounded-lg pa-3 mt-1 mb-2 bg-surface-light" data-test="pec-test">
      <div class="text-subtitle-2 mb-2">{{ t("einvoicing.channel.pec.testTitle") }}</div>
      <v-text-field
        v-model="testTo"
        :label="t('einvoicing.channel.pec.testTo')"
        :hint="t('einvoicing.channel.pec.testToHint')"
        :rules="validations.required.email"
        :error-messages="toError ?? undefined"
        persistent-hint
        type="email"
        autocomplete="off"
        density="comfortable"
        prepend-inner-icon="mdi-email-outline"
        data-test="pec-test-to"
        @update:model-value="toError = null"
      />
      <v-btn
        class="mt-3"
        color="primary"
        size="large"
        block
        prepend-icon="mdi-email-fast-outline"
        :loading="testing"
        :disabled="!view.connected"
        data-test="pec-test-run"
        @click="submitPec(runTest)"
      >
        {{ t("einvoicing.channel.pec.testRun") }}
      </v-btn>

      <div v-if="rows.length > 0" class="mt-3" data-test="pec-test-result">
        <div v-for="r in rows" :key="r.key" class="d-flex align-start py-1" style="gap: 8px" :data-test="`pec-test-${r.key}`" :data-ok="r.ok ? 'true' : 'false'">
          <v-icon :icon="r.ok ? 'mdi-check-circle' : 'mdi-close-circle'" :color="r.ok ? 'success' : 'error'" size="small" class="mt-1" />
          <div>
            <div>{{ r.label }}</div>
            <div v-if="r.reason" class="text-caption text-error" :data-test="`pec-test-${r.key}-reason`">{{ r.reason }}</div>
          </div>
        </div>
        <v-alert v-if="testPassed" type="success" variant="tonal" density="compact" class="mt-2" data-test="pec-test-passed">
          {{ t("einvoicing.channel.pec.passed", { to: testedTo }) }}
        </v-alert>
        <v-alert v-else-if="!testStale" type="error" variant="tonal" density="compact" class="mt-2" data-test="pec-test-failed">
          {{ t("einvoicing.channel.pec.failed") }}
        </v-alert>
      </div>
      <div v-if="testStale" class="text-caption text-warning mt-2" data-test="pec-test-stale">
        <v-icon icon="mdi-alert-outline" size="x-small" /> {{ t("einvoicing.channel.pec.stale") }}
      </div>
      <div v-else-if="!testPassed" class="text-caption text-medium-emphasis mt-2" data-test="pec-test-required">
        {{ t("einvoicing.channel.pec.required") }}
      </div>
    </div>
    </v-form>

    <v-form v-else-if="channelType === 'openapi'" ref="oaFormRef" data-test="openapi-form" @submit.prevent>
      <EInvoicingOpenApiNotice class="mt-2 mb-3" :signing="requestSigning" :vat-number="vatNumber" />
      <v-row>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="token"
            :label="t('einvoicing.channel.openapi.token')"
            type="password"
            autocomplete="new-password"
            :hint="t('einvoicing.channel.openapi.tokenHint')"
            persistent-hint
            :rules="validations.required.any"
            :error-messages="fieldErrors['config.token']"
            density="comfortable"
            prepend-inner-icon="mdi-key-outline"
            data-test="channel-openapi-token"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-select v-model="env" :items="baseUrlItems" :rules="validations.required.any" :label="t('einvoicing.channel.openapi.baseUrl')" :hint="baseUrl" persistent-hint density="comfortable" prepend-inner-icon="mdi-server-network" data-test="channel-openapi-baseurl" />
        </v-col>
        <v-col v-if="env === 'production'" cols="12" class="py-0">
          <v-alert type="warning" variant="tonal" density="comfortable" rounded="lg" data-test="openapi-prod-warning">
            {{ t("einvoicing.channel.openapi.prodWarning") }}
          </v-alert>
        </v-col>
        <v-col cols="12">
          <v-switch v-model="requestSigning" color="primary" hide-details density="compact" :label="t('einvoicing.channel.openapi.signingLabel')" data-test="channel-openapi-signing" />
          <div class="text-caption text-medium-emphasis">{{ t("einvoicing.channel.openapi.signingHint") }}</div>
        </v-col>
      </v-row>

      <div class="rounded-lg pa-3 mt-1 mb-2 bg-surface-light" data-test="openapi-test">
        <div class="text-subtitle-2 mb-2">{{ t("einvoicing.channel.openapi.testTitle") }}</div>
        <v-btn
          color="primary"
          size="large"
          block
          prepend-icon="mdi-lan-connect"
          :loading="oaTesting"
          :disabled="!view.connected"
          data-test="openapi-test-run"
          @click="submitOa(runOaTest)"
        >
          {{ t("einvoicing.channel.openapi.testRun") }}
        </v-btn>

        <div v-if="oaRows.length > 0" class="mt-3" data-test="openapi-test-result">
          <div v-for="r in oaRows" :key="r.key" class="d-flex align-start py-1" style="gap: 8px" :data-test="`openapi-test-${r.key}`" :data-ok="r.ok ? 'true' : 'false'">
            <v-icon :icon="r.ok ? 'mdi-check-circle' : 'mdi-close-circle'" :color="r.ok ? 'success' : 'error'" size="small" class="mt-1" />
            <div>
              <div>{{ r.label }}</div>
              <div v-if="r.remedy" class="text-caption text-error" :data-test="`openapi-test-${r.key}-remedy`">{{ r.remedy }}</div>
              <div v-if="r.detail" class="text-caption text-medium-emphasis" :data-test="`openapi-test-${r.key}-detail`">{{ t("einvoicing.channel.openapi.details", { message: r.detail }) }}</div>
            </div>
          </div>
          <v-alert v-if="oaPassed" type="success" variant="tonal" density="compact" class="mt-2" data-test="openapi-test-passed">
            {{ t("einvoicing.channel.openapi.passed") }}
          </v-alert>
          <v-alert v-else-if="!oaStale" type="error" variant="tonal" density="compact" class="mt-2" data-test="openapi-test-failed">
            {{ t("einvoicing.channel.openapi.failed") }}
          </v-alert>
        </div>
        <div v-if="oaStale" class="text-caption text-warning mt-2" data-test="openapi-test-stale">
          <v-icon icon="mdi-alert-outline" size="x-small" /> {{ t("einvoicing.channel.openapi.stale") }}
        </div>
        <div v-else-if="!oaPassed" class="text-caption text-medium-emphasis mt-2" data-test="openapi-test-required">
          {{ t("einvoicing.channel.openapi.required") }}
        </div>
      </div>
    </v-form>

    <v-alert v-else-if="channelType === 'mock'" type="info" variant="tonal" density="compact" class="mb-2" data-test="mock-hint">
      {{ t("einvoicing.channel.mockHint") }}
    </v-alert>

    <v-alert
      v-if="inboundWebhookUrl"
      type="success"
      variant="tonal"
      density="compact"
      class="mt-2 mb-2"
      data-test="channel-inbound-url"
    >
      <div class="font-weight-medium mb-1">{{ t("einvoicing.channel.inboundTitle") }}</div>
      <div class="d-flex align-center" style="gap: 8px">
        <code class="text-body-2 text-break flex-grow-1" data-test="channel-inbound-value">{{ inboundWebhookUrl }}</code>
        <v-btn size="small" variant="tonal" prepend-icon="mdi-content-copy" data-test="channel-inbound-copy" @click="copyUrl">
          {{ t("einvoicing.channel.copy") }}
        </v-btn>
      </div>
      <div class="text-caption mt-1">{{ t("einvoicing.channel.inboundHint") }}</div>
      <div class="text-caption mt-1">{{ t("einvoicing.channel.inboundSteps") }}</div>
      <div class="text-caption mt-1 text-medium-emphasis" data-test="channel-inbound-optional">{{ t("einvoicing.channel.inboundOptional") }}</div>
    </v-alert>

    <div v-if="channelType !== null" class="d-flex mt-2">
      <v-spacer />
      <v-btn color="primary" :loading="saving" :disabled="!view.connected || saveLocked" data-test="channel-save" @click="saveChannel">
        {{ t("einvoicing.channel.save") }}
      </v-btn>
    </div>
    <div v-if="!view.connected" class="text-caption text-medium-emphasis text-right">
      {{ t("einvoicing.channel.needConnection") }}
    </div>
  </div>
</template>

<style scoped>
.channel-card {
  position: relative;
  cursor: pointer;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    background-color 0.2s ease;
}
.channel-card:hover {
  box-shadow: 0 2px 10px rgba(var(--v-theme-primary), 0.18);
}
/* A ring (not a thicker border) so the selected card keeps exactly the same size. */
.channel-card--selected {
  box-shadow: 0 0 0 2px rgb(var(--v-theme-primary));
}
.channel-card__check {
  position: absolute;
  top: 10px;
  right: 10px;
}
/* The title always reserves the check's room, selected or not, so it wraps identically. */
.channel-card__title {
  padding-inline-end: 28px;
}
.channel-card:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
</style>
