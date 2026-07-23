<script setup lang="ts">
/**
 * Expenses list — server-paginated table rendered through the mandated
 * ServerTable.vue hitting GET /v1/expenses via the list
 * grammar. Parent owns query state; ServerTable owns the search field + its
 * debounce. Row click → expense edit (no detail page for this module).
 */
import { ref, computed, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import type { ListQuery } from "@/api/client";
import type { ListMeta } from "@billy/types";
import type { Expense, ExpenseStatus } from "@/types/domain";
import { minorToDisplay } from "@/utils/money";
import { enumLabel } from "@/utils/enums";
import { useSettingsStore } from "@/stores/settings";
import StatusChip from "@/components/StatusChip.vue";
import ServerTable from "@/components/tables/ServerTable.vue";
import type { ServerTableHeader } from "@/components/tables/ServerTable.vue";
import RowActionMenu from "@/components/tables/RowActionMenu.vue";
import type { RowAction } from "@/components/tables/RowActionMenu.vue";
import { useClonePrefill } from "@/composables/useClonePrefill";
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
  { title: t("expenses.columns.vendor"), key: "vendor", sortable: false },
  { title: t("expenses.columns.category"), key: "category", sortable: true },
  { title: t("expenses.columns.date"), key: "date", sortable: true },
  { title: t("expenses.columns.amount"), key: "amountMinor", sortable: true, align: "end" },
  { title: t("expenses.columns.status"), key: "status", sortable: true },
  { title: t("expenses.columns.billable"), key: "billable", sortable: false },
  { title: "", key: "actions", sortable: false, align: "end", forced: true },
]);

const { cloneRow } = useClonePrefill();

const rowActions = (item: Expense): RowAction[] => {
  return [
    {
      key: "open",
      title: t("rowActions.open"),
      icon: "mdi-open-in-app",
      handler: () => router.push({ name: "expense-edit", params: { id: item.id } }),
    },
    {
      key: "clone",
      title: t("rowActions.clone"),
      icon: "mdi-content-copy",
      handler: () => cloneRow("expense", item as unknown as Record<string, unknown>),
    },
  ];
};

// Status filter has ≤4 options → stays a plain v-select.
const STATUS_OPTIONS: ExpenseStatus[] = ["draft", "invoiced"];
// Translated option labels; the raw code stays as the submitted value.
const STATUS_ITEMS = computed(() =>
  STATUS_OPTIONS.map((v) => ({ title: enumLabel(t, "status", v), value: v })),
);

const items = ref<Expense[]>([]);
const total = ref(0);
const loading = ref(false);
const errorMessage = ref<string | null>(null);

const page = ref(1);
const itemsPerPage = ref(50);
const sortBy = ref<SortItem[]>([{ key: "date", order: "desc" }]);
const search = ref("");
const statusFilter = ref<ExpenseStatus | null>(null);

const toSortParam = (items_: SortItem[]): string | undefined => {
  if (items_.length === 0) return undefined;
  return items_.map((s) => (s.order === "desc" ? `-${s.key}` : s.key)).join(",");
};

let requestSeq = 0;

const fetchPage = async (): Promise<void> => {
  const seq = ++requestSeq;
  loading.value = true;
  errorMessage.value = null;
  const bounds = monthRangeBounds(period.year, selectedMonths.value);
  const query: ListQuery = {
    page: page.value,
    limit: itemsPerPage.value,
    sort: toSortParam(sortBy.value),
    q: search.value.trim() || undefined,
    status: statusFilter.value ?? undefined,
    "date[gte]": bounds.from,
    "date[lte]": bounds.to,
  };
  try {
    const result = await api.list<Expense>("/v1/expenses", query);
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
        ? t("expenses.loadError", { code: err.code })
        : t("expenses.loadErrorGeneric");
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
  const row = ctx.item as Expense;
  void router.push({ name: "expense-edit", params: { id: row.id } });
};

onMounted(() => {
  void settings.load();
  void fetchPage();
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 16px">
      <h1 class="text-h5">{{ t("expenses.title") }}</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" :to="{ name: 'expense-create' }">
        {{ t("expenses.new") }}
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
    <PeriodBar v-model:months="selectedMonths" kind="expenses" />

    <v-card variant="outlined" rounded="lg">
      <ServerTable
        v-model:page="page"
        v-model:ipp="itemsPerPage"
        v-model:sort-by="sortBy"
        v-model:search="search"
        table-name="expenses"
        :headers="headers"
        :items="items"
        :total="total"
        :loading="loading"
        @click:row="openRow"
      >
        <template #toolbar>
          <v-select
            v-model="statusFilter"
            :items="STATUS_ITEMS"
            :label="t('expenses.columns.status')"
            density="compact"
            hide-details
            clearable
            max-width="200"
            :aria-label="t('expenses.filterStatus')"
          />
        </template>
        <template #[`item.vendor`]="{ item }">
          {{ item.vendor }}
        </template>
        <template #[`item.amountMinor`]="{ item }">
          {{ minorToDisplay(item.amountMinor, item.currency) }}
        </template>
        <template #[`item.status`]="{ item }">
          <StatusChip :status="item.status" />
        </template>
        <template #[`item.billable`]="{ item }">
          {{ item.billable ? t("common.yes") : t("common.no") }}
        </template>
        <template #[`item.actions`]="{ item }">
          <RowActionMenu :actions="rowActions(item)" />
        </template>
        <template #no-data>
          <div class="pa-8 text-center" style="color: var(--v-billy-text-3)">
            <v-icon icon="mdi-file-document-off-outline" size="32" class="mb-2" />
            <div class="text-body-1">{{ t("expenses.empty") }}</div>
          </div>
        </template>
      </ServerTable>
    </v-card>
  </div>
</template>
