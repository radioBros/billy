<script setup lang="ts">
/**
 * Monthly-counts chart + drilldown (monthly-counts?year=).
 *
 * - Stacked bars: 12 months of the selected year, one series per doc type
 *   (invoices/proforma/quotes/creditNotes/contracts/expenses).
 * - MONTH SELECTION: click a bar to toggle that month; a month multi-select
 *   mirrors it. NONE selected = ALL months.
 * - DOC-TYPE selector: picks which type's items the list shows.
 * - LIST: the actual items for the selected month(s) + type, fetched from the
 *   EXISTING list endpoint with a date range on the type's date field PLUS the
 *   reconciling status filter (see buildDrilldownQuery). Rows are clickable →
 *   navigate to the document's detail/edit route.
 */
import { computed, defineAsyncComponent, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import { minorToDisplay } from "@/utils/money";
import {
  buildDrilldownQuery,
  DOC_TYPES,
  DRILLDOWN,
  MONTH_ABBR,
  type DocType,
  type MonthlyCount,
} from "@/components/dashboard/types";

const EChart = defineAsyncComponent(() => import("@/components/charts/EChart.vue"));

const { t } = useI18n();
const router = useRouter();

const props = defineProps<{
  rows: MonthlyCount[];
  year: number;
}>();

/**
 * Selected 1-based month numbers; empty = ALL months. Exposed as `v-model:months`
 * so the dashboard can SHARE one month selection across the KPI cards + this
 * chart's dim/drilldown. When the parent doesn't bind it, it works standalone.
 */
const selectedMonths = defineModel<number[]>("months", { default: () => [] });
const selectedType = ref<DocType>("invoices");

// A new year invalidates the month selection (months are year-scoped). The
// dashboard also resets it centrally; resetting here too is harmless + keeps the
// standalone (unbound) usage correct.
watch(
  () => props.year,
  () => {
    selectedMonths.value = [];
  },
);

const typeItems = computed(() =>
  DOC_TYPES.map((type) => ({ value: type, title: t(`dashboard.docType.${type}`) })),
);

const hasData = computed<boolean>(() => props.rows.some((r) => r.total > 0));

const chartOption = computed(() => {
  const rows = props.rows;
  const labels = rows.map((r) => MONTH_ABBR[r.monthNumber - 1] ?? "");
  const sel = new Set(selectedMonths.value);
  const anySelected = sel.size > 0;
  const series = DOC_TYPES.map((type) => ({
    name: t(`dashboard.docType.${type}`),
    type: "bar",
    stack: "counts",
    emphasis: { focus: "series" },
    data: rows.map((r) => ({
      value: r.counts[type] ?? 0,
      // Dim months outside the selection so the active bars read clearly.
      itemStyle: anySelected && !sel.has(r.monthNumber) ? { opacity: 0.35 } : undefined,
    })),
  }));
  return {
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: { data: DOC_TYPES.map((type) => t(`dashboard.docType.${type}`)), top: 0, type: "scroll" },
    grid: { left: 8, right: 16, bottom: 8, top: 48, containLabel: true },
    xAxis: { type: "category", data: labels },
    yAxis: { type: "value", minInterval: 1 },
    series,
  };
});

// ── Drilldown list ───────────────────────────────────────────────────────────
interface DrilldownRow {
  id: string;
  label: string;
  sub: string;
  date: string;
  amountMinor?: number;
  currency?: string | null;
  status?: string;
}

const listLoading = ref(false);
const listError = ref<string | null>(null);
const listRows = ref<DrilldownRow[]>([]);

const monthsLabel = computed<string>(() => {
  if (selectedMonths.value.length === 0) return t("dashboard.drilldown.allMonths");
  return [...selectedMonths.value]
    .sort((a, b) => a - b)
    .map((m) => MONTH_ABBR[m - 1] ?? "")
    .join(", ");
});

const toRow = (type: DocType, doc: Record<string, unknown>): DrilldownRow => {
  const meta = DRILLDOWN[type];
  const numField = meta.numberField;
  const titleField = meta.titleField;
  const number = numField ? (doc[numField] as string | null | undefined) : undefined;
  const title = titleField ? (doc[titleField] as string | null | undefined) : undefined;
  const label = number || title || t("dashboard.drilldown.untitled");
  const date = (doc[meta.dateField] as string | undefined) ?? "";
  const amountMinor =
    (doc.grandTotalMinor as number | undefined) ?? (doc.amountMinor as number | undefined) ??
    (doc.valueMinor as number | undefined);
  return {
    id: String(doc.id),
    label,
    sub: (doc.vendor as string | undefined) ?? (doc.category as string | undefined) ?? "",
    date,
    amountMinor,
    currency: (doc.currency as string | null | undefined) ?? null,
    status: doc.status as string | undefined,
  };
};

let requestSeq = 0;

const loadDrilldown = async (): Promise<void> => {
  const seq = ++requestSeq;
  const type = selectedType.value;
  listLoading.value = true;
  listError.value = null;
  try {
    const query = buildDrilldownQuery(type, props.year, selectedMonths.value);
    const result = await api.list<Record<string, unknown>>(DRILLDOWN[type].path, query);
    if (seq !== requestSeq) return;
    listRows.value = result.data.map((d) => toRow(type, d));
  } catch (err) {
    if (seq !== requestSeq) return;
    listRows.value = [];
    listError.value =
      err instanceof ApiError
        ? t("dashboard.drilldown.error", { code: err.code })
        : t("dashboard.drilldown.errorGeneric");
  } finally {
    if (seq === requestSeq) listLoading.value = false;
  }
};

// Refetch on any driver change: type, months, or year.
watch(
  [selectedType, selectedMonths, () => props.year],
  () => {
    void loadDrilldown();
  },
  { immediate: true, deep: true },
);

const openRow = (row: DrilldownRow): void => {
  void router.push({ name: DRILLDOWN[selectedType.value].routeName, params: { id: row.id } });
};
</script>

<template>
  <v-card variant="flat" border>
    <v-card-title class="text-subtitle-1 font-weight-medium">
      {{ t("dashboard.counts.title") }}
    </v-card-title>
    <v-card-text>
      <EChart
        v-if="hasData"
        :option="chartOption"
        height="320px"
      />
      <div v-else class="chart-empty">
        <v-icon icon="mdi-chart-bar-stacked" size="36" class="mb-2" />
        <div class="text-body-2">{{ t("dashboard.counts.empty") }}</div>
      </div>

      <!-- ── Drilldown controls ──────────────────────────────────────────── -->
      <div class="d-flex align-center flex-wrap mt-4" style="gap: 12px">
        <v-select
          v-model="selectedType"
          :items="typeItems"
          :label="t('dashboard.drilldown.docType')"
          density="compact"
          hide-details
          variant="outlined"
          style="max-width: 200px"
        />
        <span class="text-caption kpi-label">
          {{ t("dashboard.drilldown.showing", { months: monthsLabel }) }}
        </span>
      </div>

      <!-- ── Drilldown list ──────────────────────────────────────────────── -->
      <v-alert
        v-if="listError"
        type="error"
        variant="tonal"
        density="compact"
        class="mt-4"
        role="alert"
      >
        {{ listError }}
        <template #append>
          <v-btn variant="text" size="small" @click="loadDrilldown">{{ t("dashboard.retry") }}</v-btn>
        </template>
      </v-alert>

      <v-skeleton-loader v-else-if="listLoading" type="list-item-two-line@3" class="mt-2" />

      <!-- Virtual-scroll list (operator rule: all LISTS are virtual). Height is
           capped so long result sets scroll instead of rendering every row. -->
      <v-virtual-scroll
        v-else-if="listRows.length > 0"
        :items="listRows"
        :height="Math.min(listRows.length * 64, 400)"
        item-height="64"
        class="mt-2"
      >
        <template #default="{ item: row }">
          <v-list-item
            :key="row.id"
            class="drill-row"
            lines="two"
            :title="row.label"
            @click="openRow(row)"
          >
            <template #subtitle>
              <span>{{ row.date }}</span>
              <span v-if="row.sub"> · {{ row.sub }}</span>
            </template>
            <template #append>
              <span v-if="row.amountMinor != null" class="text-body-2 font-weight-medium">
                {{ minorToDisplay(row.amountMinor, row.currency) }}
              </span>
              <v-icon icon="mdi-chevron-right" class="ml-2" />
            </template>
          </v-list-item>
        </template>
      </v-virtual-scroll>

      <div v-else class="text-body-2 text-center py-6 kpi-label">
        {{ t("dashboard.drilldown.empty") }}
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.chart-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 320px;
  text-align: center;
  color: var(--v-billy-text-3);
}
.kpi-label {
  color: var(--v-billy-text-2);
}
.drill-row {
  cursor: pointer;
}
</style>
