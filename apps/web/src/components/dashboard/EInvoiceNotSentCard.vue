<script setup lang="ts">
/**
 * EInvoiceNotSentCard — dashboard action list: finalized documents not yet sent to
 * SdI, with the legal send-by date (overdue ones highlighted). Self-contained and
 * invisible unless e-invoicing is enabled AND something is pending
 * (`GET /v1/einvoicing/summary`). Rows are virtual-scrolled.
 */
import { computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { useEInvoicing } from "@/stores/einvoicing";
import type { EInvoicingSummaryItem } from "@/types/domain";

const { t } = useI18n();
const router = useRouter();
const einvoicing = useEInvoicing();

const summary = computed(() => einvoicing.summary);
const visible = computed<boolean>(
  () => einvoicing.enabled && ((summary.value?.notSent ?? 0) > 0 || (summary.value?.problems ?? 0) > 0),
);

/** blocked / failed / rejected items sit in the list too, flagged as needing attention. */
const needsAttention = (item: EInvoicingSummaryItem): boolean => !!item.status && item.status !== "not_sent";

const open = (item: EInvoicingSummaryItem): void => {
  void router.push(
    item.kind === "credit_note"
      ? { name: "credit-note-detail", params: { id: item.id } }
      : { name: "invoice-detail", params: { id: item.id } },
  );
};

onMounted(async () => {
  await einvoicing.load();
  if (einvoicing.enabled) await einvoicing.loadSummary();
});
</script>

<template>
  <v-card v-if="visible && summary" variant="flat" border class="mb-4" data-test="einvoice-not-sent-card">
    <v-card-title class="text-subtitle-1 font-weight-medium d-flex align-center" style="gap: 8px; flex-wrap: wrap">
      <v-icon icon="mdi-send-clock-outline" color="warning" />
      {{ t("einvoicing.dashboard.title") }}
      <v-chip size="small" variant="tonal" color="warning" label>{{ summary.notSent }}</v-chip>
      <v-chip v-if="(summary.problems ?? 0) > 0" size="small" variant="tonal" color="error" label data-test="einvoice-problems-count">
        {{ t("einvoicing.dashboard.problems", { n: summary.problems }) }}
      </v-chip>
      <v-chip v-if="summary.overdue > 0" size="small" variant="flat" color="error" label data-test="einvoice-overdue-count">
        {{ t("einvoicing.dashboard.overdue", { n: summary.overdue }) }}
      </v-chip>
    </v-card-title>
    <v-card-text class="pt-0">
      <v-virtual-scroll :items="summary.items" max-height="240">
        <template #default="{ item }">
          <div
            class="d-flex align-center py-2 einvoice-row"
            :class="{ 'einvoice-row--overdue': item.overdue }"
            style="gap: 12px; cursor: pointer"
            :data-test="`einvoice-row-${item.id}`"
            role="button"
            tabindex="0"
            @click="open(item)"
            @keydown.enter="open(item)"
          >
            <v-icon :icon="item.overdue || needsAttention(item) ? 'mdi-alert-circle' : 'mdi-file-document-outline'" :color="item.overdue || needsAttention(item) ? 'error' : undefined" size="small" />
            <span class="font-weight-medium">{{ item.number }}</span>
            <span class="text-medium-emphasis text-truncate flex-grow-1">{{ item.clientName }}</span>
            <v-chip v-if="needsAttention(item)" size="x-small" variant="tonal" color="error" label :data-test="`einvoice-attention-${item.id}`">
              {{ t(`einvoicing.status.${item.status}`) }}
            </v-chip>
            <span class="text-caption" :class="item.overdue ? 'text-error font-weight-bold' : ''">
              {{ item.overdue ? t("einvoicing.dashboard.overdueBy", { date: item.dueBy }) : t("einvoicing.dashboard.dueBy", { date: item.dueBy }) }}
            </span>
          </div>
        </template>
      </v-virtual-scroll>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.einvoice-row--overdue {
  background: rgba(var(--v-theme-error), 0.08);
  border-radius: 6px;
}
</style>
