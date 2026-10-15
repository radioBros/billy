<script setup lang="ts">
/**
 * Time entries list — server-paginated table rendered through the mandated
 * ServerTable.vue hitting GET /v1/time-entries via the
 * list grammar. Parent owns query state; ServerTable owns the search field + its
 * debounce. Row click → time entry edit page. Time entries have no status and no
 * monetary total column.
 */
import { ref, computed, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { useTimerStore } from "@/stores/timer";
import { api, ApiError } from "@/api/client";
import { apiErrorReason } from "@/utils/validationMessages";
import type { ListQuery } from "@/api/client";
import type { ListMeta } from "@billy/types";
import type { TimeEntry } from "@/types/domain";
import { minorToDisplay } from "@/utils/money";
import { useSettingsStore } from "@/stores/settings";
import ServerTable from "@/components/tables/ServerTable.vue";
import type { ServerTableCardLayout, ServerTableHeader } from "@/components/tables/ServerTable.vue";
import PageHeader from "@/components/PageHeader.vue";
import { useIsMobile } from "@/composables/useIsMobile";

interface SortItem {
  key: string;
  order: "asc" | "desc";
}

const { t } = useI18n();
const router = useRouter();
const settings = useSettingsStore();
const timer = useTimerStore();
const isMobile = useIsMobile();

const startTimer = (): void => {
  timer.start();
};

const headers = computed<ServerTableHeader[]>(() => [
  { title: t("timeEntries.columns.date"), key: "date", sortable: true },
  { title: t("timeEntries.columns.description"), key: "description", sortable: false },
  { title: t("timeEntries.columns.duration"), key: "durationMinutes", sortable: true },
  { title: t("timeEntries.columns.billable"), key: "billable", sortable: true },
  { title: t("timeEntries.columns.billed"), key: "billed", sortable: true },
  { title: t("timeEntries.columns.rate"), key: "rateMinor", sortable: false, align: "end" },
]);

/** Phone card: description + date, billable/billed chips, duration as the
 *  headline figure with the hourly rate underneath. */
const cardLayout: ServerTableCardLayout = {
  title: "description",
  subtitle: "date",
  status: ["billable", "billed"],
  amount: "durationMinutes",
  amountCaption: "rateMinor",
  meta: [],
};

// Billable filter has ≤4 options → stays a plain v-select.
const BILLABLE_OPTIONS = computed(() => [
  { title: t("common.yes"), value: true },
  { title: t("common.no"), value: false },
]);

const minutesToHm = (mins: number): string => {
  const total = Number.isFinite(mins) ? Math.max(0, Math.trunc(mins)) : 0;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
};

const items = ref<TimeEntry[]>([]);
const total = ref(0);
const loading = ref(false);
const errorMessage = ref<string | null>(null);

const page = ref(1);
const itemsPerPage = ref(50);
const sortBy = ref<SortItem[]>([{ key: "date", order: "desc" }]);
const search = ref("");
const billableFilter = ref<boolean | null>(null);
/** Filters differing from their default — badges the phone filter button. */
// `false` (non-billable only) is an active filter too — compare against null.
const activeFilterCount = computed<number>(() => (billableFilter.value != null ? 1 : 0));

const toSortParam = (items_: SortItem[]): string | undefined => {
  if (items_.length === 0) return undefined;
  return items_.map((s) => (s.order === "desc" ? `-${s.key}` : s.key)).join(",");
};

let requestSeq = 0;

const fetchPage = async (): Promise<void> => {
  const seq = ++requestSeq;
  loading.value = true;
  errorMessage.value = null;
  const query: ListQuery = {
    page: page.value,
    limit: itemsPerPage.value,
    sort: toSortParam(sortBy.value),
    q: search.value.trim() || undefined,
    billable: billableFilter.value ?? undefined,
  };
  try {
    const result = await api.list<TimeEntry>("/v1/time-entries", query);
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
        ? t("timeEntries.loadError", { code: apiErrorReason(err) })
        : t("timeEntries.loadErrorGeneric");
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
};

watch([page, itemsPerPage, sortBy, search], () => {
  void fetchPage();
});

watch(billableFilter, () => {
  if (page.value !== 1) page.value = 1;
  else void fetchPage();
});

const openRow = (_e: unknown, ctx: { item: unknown }): void => {
  const row = ctx.item as TimeEntry;
  void router.push({ name: "time-entry-edit", params: { id: row.id } });
};

onMounted(() => {
  void settings.load();
  void fetchPage();
});
</script>

<template>
  <div>
    <PageHeader
      :title="t('timeEntries.title')"
      :primary="{ label: t('timeEntries.new'), icon: 'mdi-plus', to: { name: 'time-entry-create' } }"
    >
      <template #actions>
        <v-btn
          variant="tonal"
          color="primary"
          prepend-icon="mdi-timer-outline"
          :disabled="timer.active"
          :class="{ 'mr-3': !isMobile }"
          @click="startTimer"
        >
          {{ t("timer.start") }}
        </v-btn>
      </template>
    </PageHeader>

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
        <v-btn color="primary" size="small" @click="fetchPage">{{ t("common.retry") }}</v-btn>
      </template>
    </v-alert>

    <v-card variant="outlined" rounded="lg">
      <ServerTable
        v-model:page="page"
        v-model:ipp="itemsPerPage"
        v-model:sort-by="sortBy"
        v-model:search="search"
        table-name="time-entries"
        :headers="headers"
        :items="items"
        :total="total"
        :loading="loading"
        :card-layout="cardLayout"
        :active-filters="activeFilterCount"
        @click:row="openRow"
      >
        <template #toolbar>
          <v-select
            v-model="billableFilter"
            :items="BILLABLE_OPTIONS"
            :label="t('timeEntries.columns.billable')"
            density="compact"
            hide-details
            clearable
            max-width="200"
            :aria-label="t('timeEntries.filterBillable')"
          />
        </template>
        <template #[`item.description`]="{ item }">
          {{ item.description }}
        </template>
        <template #[`item.durationMinutes`]="{ item }">
          {{ minutesToHm(item.durationMinutes) }}
        </template>
        <!-- Phone card: Billable / Billed as chips (shown only when true). -->
        <template #[`item.billable`]="{ item, card }">
          <template v-if="card">
            <v-chip v-if="item.billable" size="small" variant="tonal" color="success" label prepend-icon="mdi-cash-check">
              {{ t("timeEntries.columns.billable") }}
            </v-chip>
          </template>
          <template v-else>{{ item.billable ? t("common.yes") : t("common.no") }}</template>
        </template>
        <template #[`item.billed`]="{ item, card }">
          <template v-if="card">
            <v-chip v-if="item.billed" size="small" variant="tonal" color="info" label prepend-icon="mdi-receipt-text-check-outline">
              {{ t("timeEntries.columns.billed") }}
            </v-chip>
          </template>
          <template v-else>{{ item.billed ? t("common.yes") : t("common.no") }}</template>
        </template>
        <template #[`item.rateMinor`]="{ item }">
          {{ minorToDisplay(item.rateMinor, "EUR") }}
        </template>
        <template #no-data>
          <div class="pa-8 text-center" style="color: var(--v-billy-text-3)">
            <v-icon icon="mdi-timer-off-outline" size="32" class="mb-2" />
            <div class="text-body-1">{{ t("timeEntries.empty") }}</div>
          </div>
        </template>
      </ServerTable>
    </v-card>
  </div>
</template>
