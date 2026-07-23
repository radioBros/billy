<script setup lang="ts">
/**
 * Quotes list — server-paginated table rendered through the mandated
 * ServerTable.vue hitting GET /v1/quotes via the list
 * grammar. Mirrors ClientsList/InvoicesList: parent owns query state, ServerTable
 * owns the search field + its debounce. Row click → quote detail.
 */
import { ref, computed, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import type { ListQuery } from "@/api/client";
import type { ListMeta } from "@billy/types";
import type { Quote, QuoteStatus } from "@/types/domain";
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
  { title: t("quotes.columns.number"), key: "quoteNumber", sortable: true },
  { title: t("quotes.columns.status"), key: "status", sortable: true },
  { title: t("quotes.columns.issueDate"), key: "issueDate", sortable: true },
  { title: t("quotes.columns.expiryDate"), key: "expiryDate", sortable: true },
  { title: t("quotes.columns.total"), key: "grandTotalMinor", sortable: true, align: "end" },
  { title: "", key: "actions", sortable: false, align: "end", forced: true },
]);

const { cloneRow } = useClonePrefill();

const rowActions = (item: Quote): RowAction[] => {
  return [
    {
      key: "open",
      title: t("rowActions.open"),
      icon: "mdi-open-in-app",
      handler: () => router.push({ name: "quote-detail", params: { id: item.id } }),
    },
    {
      key: "clone",
      title: t("rowActions.clone"),
      icon: "mdi-content-copy",
      handler: () => cloneRow("quote", item as unknown as Record<string, unknown>),
    },
  ];
};

// Status filter has >4 options → AutocompleteSearch (static), with a null "All"
// sentinel to restore the previous clearable-to-unset behaviour. Enum option
// titles stay as their lowercase status values (rendered by StatusChip).
const STATUS_ITEMS = computed(() => [
  { title: t("quotes.allStatuses"), value: null },
  ...["draft", "sent", "accepted", "declined", "expired", "converted"].map((v) => ({
    title: enumLabel(t, "status", v),
    value: v,
  })),
] as unknown as AutocompleteItem[]);

const items = ref<Quote[]>([]);
const total = ref(0);
const loading = ref(false);
const errorMessage = ref<string | null>(null);

const page = ref(1);
const itemsPerPage = ref(50);
const sortBy = ref<SortItem[]>([{ key: "issueDate", order: "desc" }]);
const search = ref("");
const statusFilter = ref<QuoteStatus | null>(null);

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
  // issueDate range shortcut (`issueDate[gte]`/`issueDate[lte]`).
  const bounds = monthRangeBounds(period.year, selectedMonths.value);
  const query: ListQuery = {
    page: page.value,
    limit: itemsPerPage.value,
    sort: toSortParam(sortBy.value),
    q: search.value.trim() || undefined,
    status: statusFilter.value ?? undefined,
    "issueDate[gte]": bounds.from,
    "issueDate[lte]": bounds.to,
  };
  try {
    const result = await api.list<Quote>("/v1/quotes", query);
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
        ? t("quotes.loadError", { code: err.code })
        : t("quotes.loadErrorGeneric");
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
};

watch([page, itemsPerPage, sortBy, search], () => {
  void fetchPage();
});

watch(statusFilter, () => {
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
  const row = ctx.item as Quote;
  void router.push({ name: "quote-detail", params: { id: row.id } });
};

onMounted(() => {
  void settings.load();
  void fetchPage();
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 16px">
      <h1 class="text-h5">{{ t("quotes.title") }}</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" :to="{ name: 'quote-create' }">{{ t("quotes.new") }}</v-btn>
    </div>

    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
      <template #append>
        <v-btn variant="text" size="small" @click="fetchPage">{{ t("common.retry") }}</v-btn>
      </template>
    </v-alert>

    <!-- Month bar: per-month count + € total for the global year; selecting
         month(s) filters the table below (empty = whole year). -->
    <PeriodBar v-model:months="selectedMonths" kind="quotes" />

    <v-card variant="outlined" rounded="lg">
      <ServerTable
        v-model:page="page"
        v-model:ipp="itemsPerPage"
        v-model:sort-by="sortBy"
        v-model:search="search"
        table-name="quotes"
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
            :label="t('quotes.columns.status')"
            density="compact"
            hide-details
            max-width="200"
            :aria-label="t('quotes.filterStatus')"
          />
        </template>
        <template #[`item.quoteNumber`]="{ item }">{{ item.quoteNumber ?? "—" }}</template>
        <template #[`item.status`]="{ item }">
          <StatusChip :status="item.status" />
        </template>
        <template #[`item.grandTotalMinor`]="{ item }">
          {{ minorToDisplay(item.grandTotalMinor, item.currency) }}
        </template>
        <template #[`item.actions`]="{ item }">
          <RowActionMenu :actions="rowActions(item)" document-type="quote" :document-id="item.id" />
        </template>
        <template #no-data>
          <div class="pa-8 text-center" style="color: var(--v-billy-text-3)">
            <v-icon icon="mdi-file-document-off-outline" size="32" class="mb-2" />
            <div class="text-body-1">{{ t("quotes.empty") }}</div>
          </div>
        </template>
      </ServerTable>
    </v-card>
  </div>
</template>
