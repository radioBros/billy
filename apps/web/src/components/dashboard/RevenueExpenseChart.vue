<script setup lang="ts">
/**
 * Revenue / expense chart — grouped bars of invoiced, collected AND expenses for
 * the 12 months of the selected year (revenue-series?year=). Per currency: reads
 * ONLY the active currency's slice, never blending currencies.
 *
 * The parent only renders this when financials are available (a non-empty
 * revenue series); an all-zero year still renders an intentional empty state.
 */
import { computed, defineAsyncComponent } from "vue";
import { useI18n } from "vue-i18n";
import { useTheme } from "vuetify";
import { minorToDisplay } from "@/utils/money";
import { MONTH_ABBR, type RevenueMonth } from "@/components/dashboard/types";

const EChart = defineAsyncComponent(() => import("@/components/charts/EChart.vue"));

const { t } = useI18n();
const theme = useTheme();

const props = defineProps<{
  rows: RevenueMonth[];
  currency: string | null;
}>();

/** True when any month carries a non-zero invoiced/collected/expense in the active currency. */
const hasData = computed<boolean>(() => {
  const cur = props.currency;
  if (!cur) return false;
  return props.rows.some(
    (r) =>
      (r.invoiced[cur] ?? 0) !== 0 ||
      (r.collected[cur] ?? 0) !== 0 ||
      (r.expenses?.[cur] ?? 0) !== 0,
  );
});

const option = computed(() => {
  const cur = props.currency;
  const rows = props.rows;
  const c = theme.current.value.colors;
  const pick = (m: Record<string, number> | undefined): number => (cur && m ? (m[cur] ?? 0) : 0);
  const invoiced = rows.map((r) => pick(r.invoiced));
  const collected = rows.map((r) => pick(r.collected));
  const expenses = rows.map((r) => pick(r.expenses));
  const labels = rows.map((_, i) => MONTH_ABBR[i] ?? "");
  const names = {
    invoiced: t("dashboard.chart.invoiced"),
    collected: t("dashboard.chart.collected"),
    expenses: t("dashboard.chart.expenses"),
  };
  return {
    tooltip: { trigger: "axis", valueFormatter: (v: number) => minorToDisplay(v, cur) },
    legend: { data: [names.invoiced, names.collected, names.expenses], top: 0 },
    grid: { left: 8, right: 16, bottom: 8, top: 40, containLabel: true },
    xAxis: { type: "category", data: labels },
    yAxis: { type: "value", axisLabel: { formatter: (v: number) => minorToDisplay(v, cur) } },
    series: [
      { name: names.invoiced, type: "bar", data: invoiced, itemStyle: { color: c.primary } },
      { name: names.collected, type: "bar", data: collected, itemStyle: { color: c.success } },
      { name: names.expenses, type: "bar", data: expenses, itemStyle: { color: c.error } },
    ],
  };
});
</script>

<template>
  <EChart v-if="hasData" :option="option" height="320px" />
  <div v-else class="chart-empty">
    <v-icon icon="mdi-chart-bar" size="36" class="mb-2" />
    <div class="text-body-2">{{ t("dashboard.chart.revenueExpenseEmpty") }}</div>
  </div>
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
</style>
