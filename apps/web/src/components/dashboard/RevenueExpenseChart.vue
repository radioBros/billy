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
import { monthAbbr, type RevenueMonth } from "@/components/dashboard/types";
import { minorToCompact } from "@/components/dashboard/chartFormat";
import { useIsMobile } from "@/composables/useIsMobile";

const EChart = defineAsyncComponent(() => import("@/components/charts/EChart.vue"));

const { t } = useI18n();
const theme = useTheme();
const isMobile = useIsMobile();

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
  const labels = rows.map((_, i) => monthAbbr(i + 1));
  const names = {
    invoiced: t("dashboard.chart.invoiced"),
    collected: t("dashboard.chart.collected"),
    expenses: t("dashboard.chart.expenses"),
  };
  if (isMobile.value) {
    // Phones: compact money ticks, slim rounded bars, every month labelled.
    const bar = { type: "bar", barMaxWidth: 6, barGap: "15%", barCategoryGap: "30%" };
    const round = { borderRadius: [3, 3, 0, 0] };
    return {
      tooltip: { trigger: "axis", valueFormatter: (v: number) => minorToDisplay(v, cur) },
      legend: { data: [names.invoiced, names.collected, names.expenses], top: 0 },
      grid: { left: 0, right: 4, bottom: 0, top: 32, containLabel: true },
      xAxis: { type: "category", data: labels, axisTick: { show: false }, axisLabel: { interval: 1 } },
      yAxis: { type: "value", splitNumber: 4, axisLabel: { formatter: (v: number) => minorToCompact(v, cur) } },
      series: [
        { ...bar, name: names.invoiced, data: invoiced, itemStyle: { color: c.primary, ...round } },
        { ...bar, name: names.collected, data: collected, itemStyle: { color: c.success, ...round } },
        { ...bar, name: names.expenses, data: expenses, itemStyle: { color: c.error, ...round } },
      ],
    };
  }
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
  <EChart v-if="hasData" :option="option" :height="isMobile ? '240px' : '320px'" />
  <div v-else class="chart-empty" :class="{ 'chart-empty--mobile': isMobile }">
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
.chart-empty--mobile {
  height: 200px;
}
</style>
