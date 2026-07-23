<script setup lang="ts">
/**
 * Invoices list — server-paginated table rendered through the mandated
 * ServerTable.vue hitting GET /v1/invoices via the list
 * grammar. Parent owns query state (page/ipp/sort/search); ServerTable owns the
 * search field + its 320ms debounce. Loading/empty/error states.
 * Row click → invoice detail.
 */
import { ref, computed, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import type { ListQuery } from "@/api/client";
import type { ListMeta } from "@billy/types";
import type { Invoice, InvoiceStatus } from "@/types/domain";
import { minorToDisplay } from "@/utils/money";
import { enumLabel } from "@/utils/enums";
import { useSettingsStore } from "@/stores/settings";
import StatusChip from "@/components/StatusChip.vue";
import ServerTable from "@/components/tables/ServerTable.vue";
import type { ServerTableHeader } from "@/components/tables/ServerTable.vue";
import RowActionMenu from "@/components/tables/RowActionMenu.vue";
import type { RowAction } from "@/components/tables/RowActionMenu.vue";
import AutocompleteSearch from "@/components/AutocompleteSearch.vue";
import type { AutocompleteItem } from "@/components/AutocompleteSearch.vue";
import { useClonePrefill } from "@/composables/useClonePrefill";
import { confirm } from "@/composables/useConfirm";
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
  { title: t("invoices.columns.number"), key: "invoiceNumber", sortable: true },
  { title: t("invoices.columns.status"), key: "status", sortable: true },
  { title: t("invoices.columns.issueDate"), key: "issueDate", sortable: true },
  { title: t("invoices.columns.dueDate"), key: "dueDate", sortable: true },
  { title: t("invoices.columns.total"), key: "grandTotalMinor", sortable: true, align: "end" },
  { title: t("invoices.columns.due"), key: "amountDueMinor", sortable: false, align: "end" },
  { title: "", key: "actions", sortable: false, align: "end", forced: true },
]);

const { cloneRow } = useClonePrefill();

const canVoid = (item: Invoice): boolean => {
  return item.status !== "void" && item.status !== "draft" && item.status !== "scheduled";
};

const voidRow = async (item: Invoice): Promise<void> => {
  const ok = await confirm({
    title: t("invoices.confirm.voidTitle"),
    message: t("invoices.confirm.voidMessage"),
    confirmText: t("invoices.void"),
    tone: "error",
  });
  if (!ok) return;
  try {
    await api.post<Invoice>(`/v1/invoices/${item.id}/void`, undefined, { ifMatch: item.version });
    await fetchPage();
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError ? t("common.actionFailed", { code: err.code }) : t("common.actionFailedGeneric");
  }
};

const rowActions = (item: Invoice): RowAction[] => {
  const actions: RowAction[] = [
    {
      key: "open",
      title: t("rowActions.open"),
      icon: "mdi-open-in-app",
      handler: () => router.push({ name: "invoice-detail", params: { id: item.id } }),
    },
    {
      key: "clone",
      title: t("rowActions.clone"),
      icon: "mdi-content-copy",
      handler: () => cloneRow("invoice", item as unknown as Record<string, unknown>),
    },
  ];
  if (canVoid(item)) {
    actions.push({
      key: "void",
      title: t("invoices.void"),
      icon: "mdi-cancel",
      tone: "error",
      handler: () => void voidRow(item),
    });
  }
  return actions;
};

// Status filter has >4 options → AutocompleteSearch (static). A null "All"
// sentinel restores the clearable-to-unset behaviour the plain v-select had.
// Option titles are translated enum labels; the raw code stays as the value.
const STATUS_ITEMS = computed(() => [
  { title: t("invoices.allStatuses"), value: null },
  ...["draft", "scheduled", "finalized", "sent", "partially_paid", "paid", "void"].map((v) => ({
    title: enumLabel(t, "status", v),
    value: v,
  })),
] as unknown as AutocompleteItem[]);

const items = ref<Invoice[]>([]);
const total = ref(0);
const loading = ref(false);
const errorMessage = ref<string | null>(null);

const page = ref(1);
const itemsPerPage = ref(50);
const sortBy = ref<SortItem[]>([{ key: "issueDate", order: "desc" }]);
const search = ref("");
const statusFilter = ref<InvoiceStatus | null>(null);

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
    const result = await api.list<Invoice>("/v1/invoices", query);
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
        ? t("invoices.loadError", { code: err.code })
        : t("invoices.loadErrorGeneric");
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
};

// ServerTable owns page/ipp/sort/search via v-model and debounces search
// internally; one watcher drives the refetch. The status filter resets to page 1
// (and refetches once) on change.
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
  const row = ctx.item as Invoice;
  void router.push({ name: "invoice-detail", params: { id: row.id } });
};

onMounted(() => {
  void settings.load();
  void fetchPage();
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 16px">
      <h1 class="text-h5">{{ t("invoices.title") }}</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" :to="{ name: 'invoice-create' }">
        {{ t("invoices.new") }}
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

    <!-- Month bar: per-month count + € total for the global year; selecting
         month(s) filters the table below (empty = whole year). -->
    <PeriodBar v-model:months="selectedMonths" kind="invoices" />

    <v-card variant="outlined" rounded="lg">
      <ServerTable
        v-model:page="page"
        v-model:ipp="itemsPerPage"
        v-model:sort-by="sortBy"
        v-model:search="search"
        table-name="invoices"
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
            :label="t('invoices.columns.status')"
            density="compact"
            hide-details
            max-width="200"
            :aria-label="t('invoices.filterStatus')"
          />
        </template>
        <template #[`item.invoiceNumber`]="{ item }">
          {{ item.invoiceNumber ?? "—" }}
        </template>
        <template #[`item.status`]="{ item }">
          <StatusChip :status="item.status" />
        </template>
        <template #[`item.grandTotalMinor`]="{ item }">
          {{ minorToDisplay(item.grandTotalMinor, item.currency) }}
        </template>
        <template #[`item.amountDueMinor`]="{ item }">
          {{ minorToDisplay(item.amountDueMinor, item.currency) }}
        </template>
        <template #[`item.actions`]="{ item }">
          <RowActionMenu
            :actions="rowActions(item)"
            document-type="invoice"
            :document-id="item.id"
          />
        </template>
        <template #no-data>
          <div class="pa-8 text-center" style="color: var(--v-billy-text-3)">
            <v-icon icon="mdi-file-document-off-outline" size="32" class="mb-2" />
            <div class="text-body-1">{{ t("invoices.empty") }}</div>
          </div>
        </template>
      </ServerTable>
    </v-card>
  </div>
</template>
