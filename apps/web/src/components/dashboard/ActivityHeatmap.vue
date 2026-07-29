<script setup lang="ts">
/**
 * Activity heatmap — a single row of 12 month cells for the selected year,
 * colored by total document activity (monthly-counts `total`). Emphasizes the
 * busiest months: darker/hotter = more docs. Not financials-gated (counts only).
 */
import { computed, defineAsyncComponent } from "vue";
import { useI18n } from "vue-i18n";
import { useTheme } from "vuetify";
import { MONTH_ABBR, type MonthlyCount } from "@/components/dashboard/types";

const EChart = defineAsyncComponent(() => import("@/components/charts/EChart.vue"));

const { t } = useI18n();
const theme = useTheme();

const props = defineProps<{ rows: MonthlyCount[] }>();

const hasData = computed<boolean>(() => props.rows.some((r) => r.total > 0));

const option = computed(() => {
  const c = theme.current.value.colors;
  const totals = props.rows.map((r) => r.total);
  const max = Math.max(1, ...totals);
  // [monthIndex, rowIndex(0), value] cells.
  const data = props.rows.map((r, i) => [i, 0, r.total]);
  const labels = props.rows.map((_, i) => MONTH_ABBR[i] ?? "");
  return {
    tooltip: {
      position: "top",
      formatter: (p: { data: [number, number, number] }) =>
        `${labels[p.data[0]] ?? ""}: ${p.data[2]}`,
    },
    grid: { left: 8, right: 8, top: 16, bottom: 50, containLabel: true },
    xAxis: {
      type: "category",
      data: labels,
      splitArea: { show: true },
      axisTick: { show: false },
    },
    yAxis: { type: "category", data: [t("dashboard.heatmap.rowLabel")], axisTick: { show: false } },
    visualMap: {
      min: 0,
      max,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      show: false,
      inRange: { color: [c.surface, c.primary] },
    },
    series: [
      {
        name: t("dashboard.heatmap.rowLabel"),
        type: "heatmap",
        data,
        label: { show: true, formatter: (p: { data: [number, number, number] }) => String(p.data[2]) },
        emphasis: { itemStyle: { shadowBlur: 0, borderColor: c.primary, borderWidth: 2 } },
      },
    ],
  };
});
</script>

<template>
  <EChart v-if="hasData" :option="option" height="180px" />
  <div v-else class="chart-empty">
    <v-icon icon="mdi-view-grid-outline" size="36" class="mb-2" />
    <div class="text-body-2">{{ t("dashboard.heatmap.empty") }}</div>
  </div>
</template>

<style scoped>
.chart-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 180px;
  text-align: center;
  color: var(--v-billy-text-3);
}
</style>
