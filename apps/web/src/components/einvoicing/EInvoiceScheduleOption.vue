<script setup lang="ts">
/**
 * EInvoiceScheduleOption — "Send officially via SdI when issued" checkbox for the
 * schedule dialogs, with an inline warning when the client has no routing yet
 * (the invoice would be blocked when the schedule fires). Renders nothing unless
 * e-invoicing is enabled. The host owns the value (v-model) and sends it as
 * `submitOnFinalize` with the schedule call.
 */
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { EInvoiceKind, EInvoicePreflightIssue } from "@/types/domain";
import { useEInvoicing } from "@/stores/einvoicing";
import { runPreflight } from "@/composables/useEInvoice";
import EInvoiceIssueList from "@/components/einvoicing/EInvoiceIssueList.vue";
import { useIsMobile } from "@/composables/useIsMobile";

const props = defineProps<{
  kind?: EInvoiceKind;
  documentId: string;
  clientId?: string | null;
}>();

const model = defineModel<boolean>({ default: false });

const { t } = useI18n();
const einvoicing = useEInvoicing();
const isMobile = useIsMobile();
const issues = ref<EInvoicePreflightIssue[]>([]);

// Only the things that don't depend on the (still missing) number/date matter now.
const relevant = (i: EInvoicePreflightIssue): boolean =>
  i.code.startsWith("client.") || i.code === "einvoicing.not_connected" || i.code === "einvoicing.disabled";

const warnings = computed<EInvoicePreflightIssue[]>(() => issues.value.filter(relevant));

onMounted(async () => {
  await einvoicing.load();
  if (!einvoicing.enabled) return;
  try {
    const r = await runPreflight(props.kind ?? "invoices", props.documentId);
    issues.value = r.issues ?? [];
  } catch {
    // advisory only
  }
});
</script>

<template>
  <div
    v-if="einvoicing.enabled"
    data-test="einvoice-schedule-option"
    :class="{ 'einvoice-schedule--mobile': isMobile }"
  >
    <v-checkbox
      v-model="model"
      color="primary"
      hide-details
      density="comfortable"
      :label="t('einvoicing.schedule.checkbox')"
      data-test="einvoice-schedule-checkbox"
    />
    <div class="text-caption text-medium-emphasis mb-2">{{ t("einvoicing.schedule.hint") }}</div>
    <v-alert
      v-if="model && warnings.length > 0"
      type="warning"
      variant="tonal"
      density="compact"
      data-test="einvoice-schedule-warning"
    >
      <div class="mb-1">{{ t("einvoicing.schedule.routingWarning") }}</div>
      <EInvoiceIssueList :issues="warnings" :client-id="clientId" />
    </v-alert>
  </div>
</template>

<style scoped>
/* Phone: a compact advisory — smaller alert copy, wrapping checkbox label. */
.einvoice-schedule--mobile :deep(.v-checkbox .v-label) {
  white-space: normal;
  line-height: 1.3;
}
.einvoice-schedule--mobile :deep(.v-alert) {
  font-size: 0.875rem;
  line-height: 1.4;
}
.einvoice-schedule--mobile :deep(.v-alert .v-alert__content) {
  overflow-wrap: anywhere;
}
</style>
