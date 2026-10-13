<script setup lang="ts">
/** SdI status filter for the invoice / credit-note lists (`einvoiceStatus` query param). */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import AutocompleteSearch from "@/components/AutocompleteSearch.vue";
import type { AutocompleteItem } from "@/components/AutocompleteSearch.vue";
import type { EInvoiceStatus } from "@/types/domain";

const model = defineModel<EInvoiceStatus | null>({ default: null });

const { t } = useI18n();

const STATUSES: EInvoiceStatus[] = [
  "not_sent",
  "blocked",
  "queued",
  "transmitted",
  "awaiting_delivery",
  "delivered",
  "undelivered_attested",
  "accepted_by_pa",
  "rejected_by_pa",
  "rejected",
  "failed",
];

const items = computed(
  () =>
    [
      { title: t("einvoicing.list.allStatuses"), value: null },
      ...STATUSES.map((s) => ({ title: t(`einvoicing.status.${s}`), value: s })),
    ] as unknown as AutocompleteItem[],
);
</script>

<template>
  <AutocompleteSearch
    v-model="model"
    :items="items"
    :label="t('einvoicing.list.column')"
    density="compact"
    hide-details
    max-width="220"
    :aria-label="t('einvoicing.list.filter')"
    data-test="einvoice-status-filter"
  />
</template>
