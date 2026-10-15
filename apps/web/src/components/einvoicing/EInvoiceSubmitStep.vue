<script setup lang="ts">
/**
 * EInvoiceSubmitStep — "Send officially via SdI" dialog.
 *
 * Runs the preflight for a finalized document and either shows "Ready" with a
 * recipient summary, or the list of blocking issues (Fix links open in a new tab,
 * then "Re-check"). "Send to SdI now" submits and polls the status (2 s / 60 s);
 * "Not now — I'll do it later" just continues. Both end in `done`, so the host
 * decides what comes next (the invoice form goes on to the email step).
 */
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import { apiErrorReason } from "@/utils/validationMessages";
import { minorToDisplay } from "@/utils/money";
import type { Client, EInvoiceInfo, EInvoiceKind, EInvoicePreflight, EInvoiceStatus } from "@/types/domain";
import EInvoiceIssueList from "@/components/einvoicing/EInvoiceIssueList.vue";
import EInvoiceStatusChip from "@/components/einvoicing/EInvoiceStatusChip.vue";
import {
  getEInvoice,
  isApiCode,
  issuesFromError,
  runPreflight,
  submitEInvoice,
  useEInvoicePolling,
} from "@/composables/useEInvoice";
import { useIsMobile } from "@/composables/useIsMobile";

const props = defineProps<{
  modelValue: boolean;
  kind: EInvoiceKind;
  documentId: string;
  /** Client of the document — recipient summary + target of client "Fix" links. */
  clientId?: string | null;
}>();

const emit = defineEmits<{
  "update:modelValue": [boolean];
  /** `submitted` is true when the document was handed to SdI in this dialog. */
  done: [{ submitted: boolean; status: EInvoiceStatus | null }];
}>();

const { t } = useI18n();
const isMobile = useIsMobile();
const { polling, start: startPolling, stop: stopPolling } = useEInvoicePolling();

type Phase = "checking" | "ready" | "blocked" | "sending" | "sent" | "error";
const phase = ref<Phase>("checking");
const preflight = ref<EInvoicePreflight | null>(null);
const issues = ref<EInvoicePreflight["issues"]>([]);
const errorText = ref<string | null>(null);
const status = ref<EInvoiceStatus | null>(null);
const recipient = ref<{ kind: "sdi" | "pec"; value: string } | null>(null);

const blocking = (list: EInvoicePreflight["issues"]): boolean => list.some((i) => i.severity === "error");

const loadRecipient = async (): Promise<void> => {
  recipient.value = null;
  if (!props.clientId) return;
  try {
    const c = await api.get<Client>(`/v1/clients/${props.clientId}`);
    if (c?.recipientCode && c.recipientCode !== "0000000") recipient.value = { kind: "sdi", value: c.recipientCode };
    else if (c?.pecEmail) recipient.value = { kind: "pec", value: c.pecEmail };
  } catch {
    // best effort: the summary is a courtesy, the preflight is the gate
  }
};

const check = async (): Promise<void> => {
  phase.value = "checking";
  errorText.value = null;
  try {
    const result = await runPreflight(props.kind, props.documentId);
    preflight.value = result;
    issues.value = result.issues ?? [];
    phase.value = result.ok && !blocking(issues.value) ? "ready" : "blocked";
    if (phase.value === "ready") void loadRecipient();
  } catch (err) {
    errorText.value = err instanceof ApiError ? apiErrorReason(err) : t("common.actionFailedGeneric");
    phase.value = "error";
  }
};

const onPolled = (info: EInvoiceInfo): void => {
  status.value = info.status;
};

const send = async (): Promise<void> => {
  phase.value = "sending";
  errorText.value = null;
  try {
    const res = await submitEInvoice(props.kind, props.documentId);
    status.value = res?.status ?? "queued";
    phase.value = "sent";
    startPolling(props.kind, props.documentId, onPolled);
  } catch (err) {
    const fromServer = issuesFromError(err);
    if (isApiCode(err, "EINVOICE_NOT_READY") && fromServer) {
      issues.value = fromServer;
      phase.value = "blocked";
    } else if (isApiCode(err, "EINVOICE_ALREADY_SUBMITTED")) {
      phase.value = "sent";
      try {
        status.value = (await getEInvoice(props.kind, props.documentId)).status;
      } catch {
        status.value = "queued";
      }
    } else {
      errorText.value = isApiCode(err, "EINVOICE_DISABLED")
        ? t("einvoicing.submit.disabled")
        : err instanceof ApiError
          ? apiErrorReason(err)
          : t("common.actionFailedGeneric");
      phase.value = "error";
    }
  }
};

const close = (submitted: boolean): void => {
  stopPolling();
  emit("update:modelValue", false);
  emit("done", { submitted, status: status.value });
};

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      status.value = null;
      void check();
    } else {
      stopPolling();
    }
  },
  { immediate: true },
);
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="560" persistent @update:model-value="emit('update:modelValue', $event)">
    <v-card
      variant="outlined"
      rounded="lg"
      data-test="einvoice-submit-step"
      :class="{ 'einvoice-step--mobile': isMobile }"
    >
      <v-card-title>{{ t("einvoicing.submit.title") }}</v-card-title>
      <v-card-text>
        <div v-if="phase === 'checking'" class="text-center pa-6" data-test="einvoice-checking">
          <v-progress-circular indeterminate />
          <div class="text-caption mt-2">{{ t("einvoicing.submit.checking") }}</div>
        </div>

        <template v-else-if="phase === 'ready' || phase === 'sending'">
          <v-alert type="success" variant="tonal" density="compact" class="mb-3" data-test="einvoice-ready">
            {{ t("einvoicing.submit.ready") }}
          </v-alert>
          <div v-if="recipient" class="text-body-2 mb-2" data-test="einvoice-recipient">
            {{
              recipient.kind === "sdi"
                ? t("einvoicing.submit.recipientSdi", { value: recipient.value })
                : t("einvoicing.submit.recipientPec", { value: recipient.value })
            }}
            <span class="text-medium-emphasis"> · {{ t("einvoicing.submit.format") }}</span>
          </div>
          <div v-if="(preflight?.bolloMinor ?? 0) > 0" class="text-body-2 mb-2" data-test="einvoice-bollo">
            {{ t("einvoicing.submit.bollo", { amount: minorToDisplay(preflight!.bolloMinor, "EUR") }) }}
          </div>
          <EInvoiceIssueList v-if="issues.length > 0" :issues="issues" :client-id="clientId" />
          <p class="text-caption text-medium-emphasis mt-3">{{ t("einvoicing.submit.irreversible") }}</p>
        </template>

        <template v-else-if="phase === 'blocked'">
          <v-alert type="warning" variant="tonal" density="compact" class="mb-3" data-test="einvoice-blocked">
            {{ t("einvoicing.submit.blocked") }}
          </v-alert>
          <EInvoiceIssueList :issues="issues" :client-id="clientId" />
        </template>

        <template v-else-if="phase === 'sent'">
          <div class="d-flex align-center mb-2" style="gap: 8px" data-test="einvoice-sent">
            <EInvoiceStatusChip :status="status" />
            <v-progress-circular v-if="polling" indeterminate size="16" width="2" />
          </div>
          <p class="text-body-2">{{ t("einvoicing.submit.sent") }}</p>
        </template>

        <v-alert v-else type="error" variant="tonal" density="compact" role="alert" data-test="einvoice-error">
          {{ t("einvoicing.submit.error", { error: errorText ?? "" }) }}
        </v-alert>
      </v-card-text>

      <!-- Phone: stacked full-width buttons, the primary action on top. -->
      <v-card-actions :class="{ 'einvoice-step__actions--mobile': isMobile }">
        <v-spacer />
        <template v-if="phase === 'sent'">
          <v-btn
            color="primary"
            :variant="isMobile ? 'flat' : undefined"
            data-test="einvoice-continue"
            @click="close(true)"
          >{{ t("einvoicing.submit.continue") }}</v-btn>
        </template>
        <template v-else>
          <v-btn variant="text" :disabled="phase === 'sending'" data-test="einvoice-skip" @click="close(false)">
            {{ t("einvoicing.submit.notNow") }}
          </v-btn>
          <v-btn
            v-if="phase === 'blocked' || phase === 'error'"
            variant="tonal"
            color="primary"
            prepend-icon="mdi-refresh"
            data-test="einvoice-recheck"
            @click="check"
          >
            {{ t("einvoicing.submit.recheck") }}
          </v-btn>
          <v-btn
            v-if="phase === 'ready' || phase === 'sending'"
            color="primary"
            :variant="isMobile ? 'flat' : undefined"
            prepend-icon="mdi-send-check-outline"
            :loading="phase === 'sending'"
            data-test="einvoice-send"
            @click="send"
          >
            {{ t("einvoicing.submit.sendNow") }}
          </v-btn>
        </template>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
/* Phone: compact advisory copy in the sheet. */
.einvoice-step--mobile :deep(.v-alert) {
  font-size: 0.875rem;
  line-height: 1.4;
}
.einvoice-step__actions--mobile {
  flex-direction: column-reverse;
  align-items: stretch;
}
.einvoice-step__actions--mobile > :deep(.v-btn) {
  width: 100%;
  height: 48px;
  margin: 0 !important;
}
</style>
