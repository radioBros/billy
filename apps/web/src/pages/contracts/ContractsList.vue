<script setup lang="ts">
/**
 * Contracts list — server-paginated table rendered through the mandated
 * ServerTable.vue hitting GET /v1/contracts via the
 * list grammar. Parent owns query state; ServerTable owns the search field + its
 * debounce. Row click → contract edit (no detail page for this module).
 */
import { ref, computed, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import type { ListQuery } from "@/api/client";
import type { ListMeta } from "@billy/types";
import type { Contract, ContractStatus, ContractType } from "@/types/domain";
import { minorToDisplay } from "@/utils/money";
import { enumLabel } from "@/utils/enums";
import { useSettingsStore } from "@/stores/settings";
import StatusChip from "@/components/StatusChip.vue";
import ServerTable from "@/components/tables/ServerTable.vue";
import type { ServerTableHeader } from "@/components/tables/ServerTable.vue";
import RowActionMenu from "@/components/tables/RowActionMenu.vue";
import type { RowAction } from "@/components/tables/RowActionMenu.vue";
import { useClonePrefill } from "@/composables/useClonePrefill";
import AutocompleteSearch from "@/components/AutocompleteSearch.vue";
import type { AutocompleteItem } from "@/components/AutocompleteSearch.vue";
import SendDocumentModal from "@/components/SendDocumentModal.vue";
import PeriodBar from "@/components/PeriodBar.vue";
import { usePeriodStore } from "@/stores/period";
import { monthRangeBounds } from "@/utils/period";

interface SortItem {
  key: string;
  order: "asc" | "desc";
}

const { t } = useI18n();
const router = useRouter();
const settings = useSettingsStore();
const period = usePeriodStore();

/** Month bar selection (1-based month numbers; empty = whole year). */
const selectedMonths = ref<number[]>([]);

const headers = computed<ServerTableHeader[]>(() => [
  { title: t("contracts.columns.title"), key: "title", sortable: true },
  { title: t("contracts.columns.type"), key: "type", sortable: true },
  { title: t("contracts.columns.status"), key: "status", sortable: true },
  { title: t("contracts.columns.start"), key: "startDate", sortable: true },
  { title: t("contracts.columns.end"), key: "endDate", sortable: true },
  { title: t("contracts.columns.value"), key: "valueMinor", sortable: false, align: "end" },
  { title: "", key: "actions", sortable: false, align: "end", forced: true },
]);

const { cloneRow } = useClonePrefill();

// send-document modal state (opened from a row's "Send" action).
const sendModal = ref(false);
const sendContract = ref<Contract | null>(null);
const openSend = (item: Contract): void => {
  sendContract.value = item;
  sendModal.value = true;
};

const rowActions = (item: Contract): RowAction[] => {
  return [
    {
      key: "open",
      title: t("rowActions.open"),
      icon: "mdi-open-in-app",
      handler: () => router.push({ name: "contract-detail", params: { id: item.id } }),
    },
    {
      key: "edit",
      title: t("common.edit"),
      icon: "mdi-pencil",
      handler: () => router.push({ name: "contract-edit", params: { id: item.id } }),
    },
    {
      key: "send",
      title: t("contracts.send"),
      icon: "mdi-email-outline",
      handler: () => openSend(item),
    },
    {
      key: "clone",
      title: t("rowActions.clone"),
      icon: "mdi-content-copy",
      handler: () => cloneRow("contract", item as unknown as Record<string, unknown>),
    },
  ];
};

// Status (7) and type (8) filters both have >4 options → AutocompleteSearch
// (static). A null "All" sentinel restores the previous clearable behaviour.
// Enum option titles stay as their raw values (rendered by StatusChip).
const STATUS_ITEMS = computed(() => [
  { title: t("contracts.allStatuses"), value: null },
  ...["draft", "active", "expiring", "expired", "terminated", "renewed", "archived"].map((v) => ({
    title: enumLabel(t, "status", v),
    value: v,
  })),
] as unknown as AutocompleteItem[]);

const TYPE_ITEMS = computed(() => [
  { title: t("contracts.allTypes"), value: null },
  ...[
    "development",
    "maintenance",
    "hosting",
    "support",
    "consulting",
    "service_agreement",
    "retainer",
    "other",
  ].map((v) => ({ title: enumLabel(t, "contractType", v), value: v })),
] as unknown as AutocompleteItem[]);

const items = ref<Contract[]>([]);
const total = ref(0);
const loading = ref(false);
const errorMessage = ref<string | null>(null);

const page = ref(1);
const itemsPerPage = ref(50);
const sortBy = ref<SortItem[]>([{ key: "startDate", order: "desc" }]);
const search = ref("");
const statusFilter = ref<ContractStatus | null>(null);
const typeFilter = ref<ContractType | null>(null);

const toSortParam = (items_: SortItem[]): string | undefined => {
  if (items_.length === 0) return undefined;
  return items_.map((s) => (s.order === "desc" ? `-${s.key}` : s.key)).join(",");
};

let requestSeq = 0;

const fetchPage = async (): Promise<void> => {
  const seq = ++requestSeq;
  loading.value = true;
  errorMessage.value = null;
  // Scope the list to the globally-selected year + month bar selection via the
  // startDate range shortcut (`startDate[gte]`/`startDate[lte]`).
  const bounds = monthRangeBounds(period.year, selectedMonths.value);
  const query: ListQuery = {
    page: page.value,
    limit: itemsPerPage.value,
    sort: toSortParam(sortBy.value),
    q: search.value.trim() || undefined,
    status: statusFilter.value ?? undefined,
    type: typeFilter.value ?? undefined,
    "startDate[gte]": bounds.from,
    "startDate[lte]": bounds.to,
  };
  try {
    const result = await api.list<Contract>("/v1/contracts", query);
    if (seq !== requestSeq) return;
    items.value = result.data;
    const meta: ListMeta = result.meta;
    total.value = typeof meta.total === "number" ? meta.total : result.data.length;
  } catch (err) {
    if (seq !== requestSeq) return;
    items.value = [];
    total.value = 0;
    errorMessage.value =
      err instanceof ApiError
        ? t("contracts.loadError", { code: err.code })
        : t("contracts.loadErrorGeneric");
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
};

watch([page, itemsPerPage, sortBy, search], () => {
  void fetchPage();
});

watch([statusFilter, typeFilter], () => {
  if (page.value !== 1) page.value = 1;
  else void fetchPage();
});

// Global year change resets the month selection (months are year-scoped); a
// month-bar selection change (or the year reset) re-scopes the list to page 1.
watch(
  () => period.year,
  () => {
    selectedMonths.value = [];
  },
);
watch(
  selectedMonths,
  () => {
    if (page.value !== 1) page.value = 1;
    else void fetchPage();
  },
  { deep: true },
);

const openRow = (_e: unknown, ctx: { item: unknown }): void => {
  const row = ctx.item as Contract;
  void router.push({ name: "contract-detail", params: { id: row.id } });
};

onMounted(() => {
  void settings.load();
  void fetchPage();
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 16px">
      <h1 class="text-h5">{{ t("contracts.title") }}</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" :to="{ name: 'contract-create' }">
        {{ t("contracts.new") }}
      </v-btn>
    </div>

    <v-alert
      v-if="errorMessage"
      type="error"
      variant="tonal"
      density="compact"
      class="mb-4"
      role="alert"
    >
      {{ errorMessage }}
      <template #append>
        <v-btn variant="text" size="small" @click="fetchPage">{{ t("common.retry") }}</v-btn>
      </template>
    </v-alert>

    <!-- Month bar: per-month count for the global year (contracts are count-only,
         no € total); selecting month(s) filters the table below. -->
    <PeriodBar v-model:months="selectedMonths" kind="contracts" />

    <v-card variant="outlined" rounded="lg">
      <ServerTable
        v-model:page="page"
        v-model:ipp="itemsPerPage"
        v-model:sort-by="sortBy"
        v-model:search="search"
        table-name="contracts"
        :headers="headers"
        :items="items"
        :total="total"
        :loading="loading"
        @click:row="openRow"
      >
        <template #toolbar>
          <AutocompleteSearch
            v-model="statusFilter"
            :items="STATUS_ITEMS"
            :label="t('contracts.columns.status')"
            density="compact"
            hide-details
            max-width="200"
            :aria-label="t('contracts.filterStatus')"
          />
          <AutocompleteSearch
            v-model="typeFilter"
            :items="TYPE_ITEMS"
            :label="t('contracts.columns.type')"
            density="compact"
            hide-details
            max-width="200"
            :aria-label="t('contracts.filterType')"
          />
        </template>
        <template #[`item.status`]="{ item }">
          <StatusChip :status="item.status" />
        </template>
        <template #[`item.type`]="{ item }">
          {{ enumLabel(t, "contractType", item.type) }}
        </template>
        <template #[`item.endDate`]="{ item }">
          {{ item.endDate ?? "—" }}
        </template>
        <template #[`item.valueMinor`]="{ item }">
          {{ minorToDisplay(item.valueMinor, item.currency) }}
        </template>
        <template #[`item.actions`]="{ item }">
          <RowActionMenu
            :actions="rowActions(item)"
            document-type="contract"
            :document-id="item.id"
          />
        </template>
        <template #no-data>
          <div class="pa-8 text-center" style="color: var(--v-billy-text-3)">
            <v-icon icon="mdi-file-document-off-outline" size="32" class="mb-2" />
            <div class="text-body-1">{{ t("contracts.empty") }}</div>
          </div>
        </template>
      </ServerTable>
    </v-card>

    <SendDocumentModal
      v-if="sendContract"
      v-model="sendModal"
      document-type="contract"
      :document-id="sendContract.id"
      kind="invoice"
      :version="sendContract.version"
    />
  </div>
</template>
