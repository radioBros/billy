<script setup lang="ts">
/**
 * EInvoicePanel — the "E-invoice (SdI)" card on invoice / credit-note detail.
 *
 * Self-loading (`GET /:kind/:id/einvoice`) and invisible when e-invoicing is off.
 * Shows the status, guidance copy (e.g. "issued — do NOT resubmit"), the deadline
 * warning, the SdI ids, and an attempts/receipts timeline with the SdI error code,
 * description and remedy. Every action is shown only when the server says it is
 * valid (`canSubmit` / `canRetry` / `hasXml`). Polls after submit / retry.
 */
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ApiError } from "@/api/client";
import { apiBaseUrl } from "@/config";
import { apiErrorReason } from "@/utils/validationMessages";
import type { EInvoiceInfo, EInvoiceKind } from "@/types/domain";
import EInvoiceStatusChip from "@/components/einvoicing/EInvoiceStatusChip.vue";
import EInvoiceSubmitStep from "@/components/einvoicing/EInvoiceSubmitStep.vue";
import {
  einvoiceFileUrl,
  getEInvoice,
  retryEInvoice,
  setSubmitOnFinalize,
  useEInvoicePolling,
} from "@/composables/useEInvoice";

const props = defineProps<{
  kind: EInvoiceKind;
  documentId: string;
  clientId?: string | null;
  /** Scheduled (not yet issued) invoice: show the "send via SdI when issued" switch. */
  scheduled?: boolean;
  /** Bump to force a reload (e.g. the parent finalized / voided the document). */
  refreshKey?: string | number | null;
}>();

const emit = defineEmits<{
  /** Every fresh snapshot — lets the host hide "Void" once legally issued. */
  loaded: [EInvoiceInfo];
}>();

const { t, te } = useI18n();
const { polling, start: startPolling } = useEInvoicePolling();

const info = ref<EInvoiceInfo | null>(null);
const loading = ref(false);
const acting = ref(false);
const errorText = ref<string | null>(null);
const submitOpen = ref(false);

const apply = (next: EInvoiceInfo): void => {
  info.value = next;
  emit("loaded", next);
};

const load = async (): Promise<void> => {
  loading.value = true;
  errorText.value = null;
  try {
    apply(await getEInvoice(props.kind, props.documentId));
    if (info.value?.inFlight) startPolling(props.kind, props.documentId, apply);
  } catch (err) {
    // 403/404 etc.: the panel simply stays out of the way when it cannot load.
    info.value = null;
    if (err instanceof ApiError && err.status >= 500) errorText.value = apiErrorReason(err);
  } finally {
    loading.value = false;
  }
};

const visible = computed<boolean>(() => info.value?.enabled === true);

const retry = async (): Promise<void> => {
  acting.value = true;
  errorText.value = null;
  try {
    await retryEInvoice(props.kind, props.documentId);
    await load();
    startPolling(props.kind, props.documentId, apply);
  } catch (err) {
    errorText.value = err instanceof ApiError ? apiErrorReason(err) : t("common.actionFailedGeneric");
  } finally {
    acting.value = false;
  }
};

const onSubmitDone = async (): Promise<void> => {
  await load();
  startPolling(props.kind, props.documentId, apply);
};

const toggleSubmitOnFinalize = async (value: boolean | null): Promise<void> => {
  acting.value = true;
  errorText.value = null;
  try {
    apply(await setSubmitOnFinalize(props.kind, props.documentId, value === true));
  } catch (err) {
    errorText.value = err instanceof ApiError ? apiErrorReason(err) : t("common.actionFailedGeneric");
    await load();
  } finally {
    acting.value = false;
  }
};

const fileHref = (what: "xml" | "rendered"): string =>
  `${apiBaseUrl().replace(/\/$/u, "")}${einvoiceFileUrl(props.kind, props.documentId, what)}`;

// Only the guidance that asks the user to do something is shown (not the calm "issued" note).
const ACTIONABLE_GUIDANCE: ReadonlySet<string> = new Set(["rejected_reissue", "failed_retry", "undelivered_tell_client"]);

const GUIDANCE_TONE: Record<string, "success" | "error" | "warning" | "info"> = {
  issued_do_not_resubmit: "success",
  rejected_reissue: "error",
  failed_retry: "warning",
  undelivered_tell_client: "info",
};

// The status of an unsent/blocked doc is what the deadline note is about.
const showDeadline = computed<boolean>(
  () => info.value?.deadline != null && (info.value.status === "not_sent" || info.value.status === "blocked"),
);

const fmt = (iso: string | null | undefined): string => (iso ? iso.replace("T", " ").slice(0, 16) : "—");

/** One flat, virtual-scrolled timeline: attempt headers, their receipts, and each SdI error. */
interface TimelineRow {
  key: string;
  type: "attempt" | "receipt" | "error";
  at: string;
  attempt?: number;
  status?: EInvoiceInfo["status"];
  receipt?: string;
  code?: string;
  description?: string;
  remedy?: string;
}

const timeline = computed<TimelineRow[]>(() => {
  const rows: TimelineRow[] = [];
  for (const a of [...(info.value?.attempts ?? [])].reverse()) {
    rows.push({ key: `a${a.attempt}`, type: "attempt", at: a.at, attempt: a.attempt, status: a.status });
    a.receipts.forEach((r, ri) => {
      rows.push({ key: `a${a.attempt}r${ri}`, type: "receipt", at: r.receivedAt, receipt: r.type });
      (r.errors ?? []).forEach((e, ei) => {
        rows.push({
          key: `a${a.attempt}r${ri}e${ei}`,
          type: "error",
          at: r.receivedAt,
          code: e.code,
          description: e.description,
          remedy: e.remedy,
        });
      });
    });
  }
  return rows;
});

const receiptLabel = (type: string): string => (te(`einvoicing.receipts.${type}`) ? t(`einvoicing.receipts.${type}`) : type);

onMounted(() => void load());
watch(() => [props.documentId, props.refreshKey], () => void load());
</script>

<template>
  <v-sheet v-if="visible && info" rounded="lg" class="einvoice-sheet pa-3 mb-4" data-test="einvoice-panel">
    <div>
      <div class="d-flex align-center mb-2" style="gap: 8px; flex-wrap: wrap">
        <EInvoiceStatusChip :status="info.status" />
        <v-progress-circular v-if="polling" indeterminate size="14" width="2" />
        <span v-if="info.submittedAt" class="text-caption text-medium-emphasis" data-test="einvoice-sent-line">
          {{ t("einvoicing.panel.sentOn", { date: fmt(info.submittedAt) }) }}
        </span>
        <v-spacer />
        <v-btn
          size="small"
          variant="text"
          density="comfortable"
          prepend-icon="mdi-refresh"
          :loading="loading"
          data-test="einvoice-refresh"
          @click="load"
        >
          {{ t("einvoicing.panel.refresh") }}
        </v-btn>
      </div>

      <v-alert v-if="errorText" type="error" variant="tonal" density="compact" class="mb-2" role="alert">
        {{ errorText }}
      </v-alert>

      <v-alert
        v-if="ACTIONABLE_GUIDANCE.has(info.guidance)"
        :type="GUIDANCE_TONE[info.guidance] ?? 'info'"
        variant="tonal"
        density="compact"
        class="mb-2"
        data-test="einvoice-guidance"
      >
        {{ t(`einvoicing.guidance.${info.guidance}`) }}
      </v-alert>

      <div
        v-if="showDeadline && info.deadline"
        class="text-caption mb-2"
        :class="info.deadline.overdue ? 'text-error' : 'text-medium-emphasis'"
        data-test="einvoice-deadline"
      >
        {{
          info.deadline.overdue
            ? t("einvoicing.panel.deadlineOverdue", { date: info.deadline.dueBy })
            : t("einvoicing.panel.deadline", { date: info.deadline.dueBy })
        }}
        <span v-if="info.deadline.finalizedBeforeEnable">· {{ t("einvoicing.panel.finalizedBeforeEnable") }}</span>
      </div>

      <v-switch
        v-if="scheduled"
        :model-value="info.submitOnFinalize"
        color="primary"
        hide-details
        density="compact"
        :disabled="acting"
        :label="t('einvoicing.schedule.checkbox')"
        data-test="einvoice-submit-on-finalize"
        @update:model-value="toggleSubmitOnFinalize"
      />

      <v-row v-if="info.identificativoSdI || info.fileName || info.submittedAt" dense class="mb-2">
        <v-col v-if="info.identificativoSdI" cols="12" sm="4">
          <div class="text-caption">{{ t("einvoicing.panel.identificativoSdI") }}</div>
          <span data-test="einvoice-sdi-id">{{ info.identificativoSdI }}</span>
        </v-col>
        <v-col v-if="info.fileName" cols="12" sm="5">
          <div class="text-caption">{{ t("einvoicing.panel.fileName") }}</div>
          <span class="text-break">{{ info.fileName }}</span>
        </v-col>
        <v-col v-if="info.submittedAt" cols="12" sm="3">
          <div class="text-caption">{{ t("einvoicing.panel.submittedAt") }}</div>
          {{ fmt(info.submittedAt) }}
        </v-col>
      </v-row>

      <div v-if="info.lastError" class="text-body-2 text-error mb-2" data-test="einvoice-last-error">
        {{ info.lastError.code }} — {{ info.lastError.message }}
      </div>

      <template v-if="timeline.length > 0">
        <div class="text-caption mb-1">{{ t("einvoicing.panel.history") }}</div>
        <v-virtual-scroll :items="timeline" max-height="260" data-test="einvoice-timeline">
          <template #default="{ item: row }">
            <div v-if="row.type === 'attempt'" class="d-flex align-center py-1" style="gap: 8px">
              <v-icon icon="mdi-send-outline" size="small" />
              <span class="text-body-2 font-weight-medium">{{ t("einvoicing.panel.attempt", { n: row.attempt }) }}</span>
              <EInvoiceStatusChip v-if="row.status" :status="row.status" size="x-small" />
              <span class="text-caption text-medium-emphasis">{{ fmt(row.at) }}</span>
            </div>
            <div v-else-if="row.type === 'receipt'" class="d-flex align-center py-1 pl-6" style="gap: 8px">
              <v-icon icon="mdi-email-check-outline" size="small" />
              <span class="text-body-2" :data-test="`receipt-${row.receipt}`">{{ receiptLabel(row.receipt ?? '') }}</span>
              <span class="text-caption text-medium-emphasis">{{ fmt(row.at) }}</span>
            </div>
            <div v-else class="py-1 pl-12 text-body-2" data-test="einvoice-sdi-error">
              <span class="font-weight-medium text-error">{{ row.code }}</span>
              <span v-if="row.description"> — {{ row.description }}</span>
              <div v-if="row.remedy" class="text-caption text-medium-emphasis">
                {{ t("einvoicing.panel.remedy") }}: {{ row.remedy }}
              </div>
            </div>
          </template>
        </v-virtual-scroll>
      </template>

      <div class="d-flex mt-2" style="gap: 8px; flex-wrap: wrap">
        <v-btn
          v-if="info.canSubmit"
          color="primary"
          prepend-icon="mdi-send-check-outline"
          :loading="acting"
          data-test="einvoice-action-submit"
          @click="submitOpen = true"
        >
          {{ t("einvoicing.panel.send") }}
        </v-btn>
        <v-btn
          v-if="info.canRetry"
          color="warning"
          variant="tonal"
          prepend-icon="mdi-reload"
          :loading="acting"
          data-test="einvoice-action-retry"
          @click="retry"
        >
          {{ t("einvoicing.panel.retry") }}
        </v-btn>
        <v-btn
          v-if="info.hasXml"
          variant="tonal"
          prepend-icon="mdi-xml"
          :href="fileHref('xml')"
          download
          data-test="einvoice-action-xml"
        >
          {{ t("einvoicing.panel.downloadXml") }}
        </v-btn>
        <v-btn
          v-if="info.hasXml"
          variant="tonal"
          prepend-icon="mdi-file-eye-outline"
          :href="fileHref('rendered')"
          target="_blank"
          rel="noopener"
          data-test="einvoice-action-rendered"
        >
          {{ t("einvoicing.panel.viewRendered") }}
        </v-btn>
      </div>
    </div>

    <EInvoiceSubmitStep
      v-model="submitOpen"
      :kind="kind"
      :document-id="documentId"
      :client-id="clientId"
      @done="onSubmitDone"
    />
  </v-sheet>
</template>

<style scoped>
.einvoice-sheet {
  background: rgba(var(--v-theme-on-surface), 0.04);
}
</style>
