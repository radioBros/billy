<script setup lang="ts">
/**
 * Activity heatmap — a single row of 12 month cells for the selected year,
 * colored by total document activity (monthly-counts `total`). Emphasizes the
 * busiest months: darker/hotter = more docs. Not financials-gated (counts only).
 */
import { computed, defineAsyncComponent } from "vue";
import { useI18n } from "vue-i18n";
import { useTheme } from "vuetify";
import { monthAbbr, type MonthlyCount } from "@/components/dashboard/types";
import { useIsMobile } from "@/composables/useIsMobile";

const EChart = defineAsyncComponent(() => import("@/components/charts/EChart.vue"));

const { t } = useI18n();
const theme = useTheme();
const isMobile = useIsMobile();

const props = defineProps<{ rows: MonthlyCount[] }>();

const hasData = computed<boolean>(() => props.rows.some((r) => r.total > 0));

const option = computed(() => {
  const c = theme.current.value.colors;
  const totals = props.rows.map((r) => r.total);
  const max = Math.max(1, ...totals);
  // [monthIndex, rowIndex(0), value] cells.
  const data = props.rows.map((r, i) => [i, 0, r.total]);
  const labels = props.rows.map((_, i) => monthAbbr(i + 1));
  if (isMobile.value) {
    // Phones: one condensed strip — no row label/legend (the card title says
    // what it is), every month labelled, rounded cells with a surface gap.
    return {
      tooltip: {
        position: "top",
        formatter: (p: { data: [number, number, number] }) => `${labels[p.data[0]] ?? ""}: ${p.data[2]}`,
      },
      legend: { show: false },
      grid: { left: 0, right: 0, top: 4, bottom: 20 },
      xAxis: {
        type: "category",
        data: labels,
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { interval: 0, fontSize: 10, hideOverlap: false },
      },
      yAxis: { type: "category", data: [""], axisTick: { show: false }, axisLine: { show: false }, axisLabel: { show: false } },
      visualMap: {
        min: 0,
        max,
        show: false,
        inRange: { color: [c.background ?? c.surface, c.primary] },
      },
      series: [
        {
          name: t("dashboard.heatmap.rowLabel"),
          type: "heatmap",
          data,
          itemStyle: { borderColor: c.surface, borderWidth: 2, borderRadius: 6 },
          label: {
            show: true,
            fontSize: 11,
            formatter: (p: { data: [number, number, number] }) => String(p.data[2]),
          },
          emphasis: { itemStyle: { shadowBlur: 0, borderColor: c.primary, borderWidth: 2 } },
        },
      ],
    };
  }
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
  <EChart v-if="hasData" :option="option" :height="isMobile ? '84px' : '180px'" />
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
