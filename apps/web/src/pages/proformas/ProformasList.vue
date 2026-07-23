<script setup lang="ts">
/**
 * Proformas list — server-paginated table through the mandated ServerTable.vue
 * Parent owns query state; fetches
 * GET /v1/proformas via the list grammar. Row click → detail.
 * Only whitelisted sort fields are marked sortable.
 */
import { ref, computed, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import type { ListQuery } from "@/api/client";
import type { ListMeta } from "@billy/types";
import type { Proforma } from "@/types/domain";
import { useSettingsStore } from "@/stores/settings";
import { minorToDisplay } from "@/utils/money";
import ServerTable from "@/components/tables/ServerTable.vue";
import type { ServerTableHeader } from "@/components/tables/ServerTable.vue";
import RowActionMenu from "@/components/tables/RowActionMenu.vue";
import type { RowAction } from "@/components/tables/RowActionMenu.vue";
import { useClonePrefill } from "@/composables/useClonePrefill";
import { confirm } from "@/composables/useConfirm";
import StatusChip from "@/components/StatusChip.vue";
import PeriodBar from "@/components/PeriodBar.vue";
import { usePeriodStore } from "@/stores/period";
import { monthRangeBounds } from "@/utils/period";

const { t } = useI18n();
const router = useRouter();
const settings = useSettingsStore();
const period = usePeriodStore();

/** Month bar selection (1-based month numbers; empty = whole year). */
const selectedMonths = ref<number[]>([]);

interface SortItem {
  key: string;
  order: "asc" | "desc";
}

const headers = computed<ServerTableHeader[]>(() => [
  { title: t("proformas.columns.number"), key: "proformaNumber", sortable: true },
  { title: t("proformas.columns.client"), key: "clientId", sortable: false },
  { title: t("proformas.columns.status"), key: "status", sortable: true },
  { title: t("proformas.columns.issueDate"), key: "issueDate", sortable: true },
  { title: t("proformas.columns.expiryDate"), key: "expiryDate", sortable: true },
  { title: t("proformas.columns.total"), key: "grandTotalMinor", sortable: true, align: "end" },
  { title: "", key: "actions", sortable: false, align: "end", forced: true },
]);

const { cloneRow } = useClonePrefill();

const voidRow = async (item: Proforma): Promise<void> => {
  const ok = await confirm({
    title: t("proformas.confirm.voidTitle"),
    message: t("proformas.confirm.voidMessage"),
    confirmText: t("proformas.void"),
    tone: "error",
  });
  if (!ok) return;
  try {
    await api.post<Proforma>(`/v1/proformas/${item.id}/void`, undefined, { ifMatch: item.version });
    await fetchPage();
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError ? t("common.actionFailed", { code: err.code }) : t("common.actionFailedGeneric");
  }
};

const rowActions = (item: Proforma): RowAction[] => {
  const actions: RowAction[] = [
    {
      key: "open",
      title: t("rowActions.open"),
      icon: "mdi-open-in-app",
      handler: () => router.push({ name: "proforma-detail", params: { id: item.id } }),
    },
    {
      key: "clone",
      title: t("rowActions.clone"),
      icon: "mdi-content-copy",
      handler: () => cloneRow("proforma", item as unknown as Record<string, unknown>),
    },
  ];
  if (item.status !== "void") {
    actions.push({
      key: "void",
      title: t("proformas.void"),
      icon: "mdi-cancel",
      tone: "error",
      handler: () => void voidRow(item),
    });
  }
  return actions;
};

const items = ref<Proforma[]>([]);
const total = ref(0);
const loading = ref(false);
const errorMessage = ref<string | null>(null);

const page = ref(1);
const itemsPerPage = ref(50);
const sortBy = ref<SortItem[]>([{ key: "issueDate", order: "desc" }]);
const search = ref("");

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
    "issueDate[gte]": bounds.from,
    "issueDate[lte]": bounds.to,
  };
  try {
    const result = await api.list<Proforma>("/v1/proformas", query);
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
        ? t("proformas.loadError", { code: err.code })
        : t("proformas.loadErrorGeneric");
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
};

const openRow = (_e: unknown, ctx: { item: unknown }): void => {
  void router.push({ name: "proforma-detail", params: { id: (ctx.item as Proforma).id } });
};

watch([page, itemsPerPage, sortBy, search], () => {
  void fetchPage();
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

onMounted(() => {
  void settings.load();
  void fetchPage();
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 16px">
      <h1 class="text-h5">{{ t("proformas.title") }}</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" :to="{ name: 'proforma-create' }">
        {{ t("proformas.new") }}
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
        <v-btn variant="text" size="small" @click="fetchPage">{{ t("proformas.retry") }}</v-btn>
      </template>
    </v-alert>

    <!-- Month bar: per-month count + € total for the global year; selecting
         month(s) filters the table below (empty = whole year). -->
    <PeriodBar v-model:months="selectedMonths" kind="proformas" />

    <v-card variant="outlined" rounded="lg">
      <ServerTable
        v-model:page="page"
        v-model:ipp="itemsPerPage"
        v-model:sort-by="sortBy"
        v-model:search="search"
        table-name="proformas"
        :headers="headers"
        :items="items"
        :total="total"
        :loading="loading"
        @click:row="openRow"
      >
        <template #[`item.proformaNumber`]="{ item }">
          {{ (item as Proforma).proformaNumber ?? t("proformas.draftUnnumbered") }}
        </template>
        <template #[`item.status`]="{ item }">
          <StatusChip :status="(item as Proforma).status" />
        </template>
        <template #[`item.expiryDate`]="{ item }">
          {{ (item as Proforma).expiryDate ?? "—" }}
        </template>
        <template #[`item.grandTotalMinor`]="{ item }">
          {{ minorToDisplay((item as Proforma).grandTotalMinor, (item as Proforma).currency) }}
        </template>
        <template #[`item.actions`]="{ item }">
          <RowActionMenu
            :actions="rowActions(item as Proforma)"
            document-type="proforma"
            :document-id="(item as Proforma).id"
          />
        </template>
        <template #no-data>
          <div class="pa-8 text-center" style="color: var(--v-billy-text-3)">
            <v-icon icon="mdi-file-document-check-outline" size="32" class="mb-2" />
            <div class="text-body-1">{{ t("proformas.empty") }}</div>
          </div>
        </template>
      </ServerTable>
    </v-card>
  </div>
</template>
