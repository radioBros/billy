<script setup lang="ts">
/**
 * Reusable ECharts wrapper (Dashboard charts).
 *
 * PWA-friendly: imports from `echarts/core` with EXPLICIT feature registration
 * (line/bar/pie + grid/tooltip/legend/title + canvas renderer) — NOT the full
 * `echarts` barrel — so tree-shaking keeps the chunk small. This component itself
 * is only ever reached through a dynamic `import()` (see Dashboard.vue), so echarts
 * lands in a lazily-loaded chunk, out of the initial bundle.
 *
 * The consumer passes a partial ECharts option (series/xAxis/etc). This wrapper
 * owns the chart lifecycle: init, resize (ResizeObserver), theme-driven recolor,
 * reduced-motion, and dispose-on-unmount. Theme colors are injected here so callers
 * don't repeat them; callers may still override any option field.
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useTheme } from "vuetify";
import * as echarts from "echarts/core";
import { BarChart, HeatmapChart, LineChart, PieChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";

echarts.use([
  LineChart,
  BarChart,
  PieChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

const props = defineProps<{
  /** Partial ECharts option (series, axes, tooltip formatter, …). */
  option: EChartsCoreOption;
  /** CSS height for the chart container. */
  height?: string;
  /**
   * ECharts event handlers keyed by event name (e.g. `{ click: fn }`). Bound
   * once after init and rebound whenever the map changes; lets callers react to
   * bar/point clicks without reaching into the chart instance.
   */
  onEvents?: Record<string, (params: unknown) => void>;
}>();

const theme = useTheme();
const el = ref<HTMLElement | null>(null);
let chart: echarts.ECharts | null = null;
let ro: ResizeObserver | null = null;

const prefersReducedMotion = (): boolean => {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
};

const themeTokens = () => {
  const cur = theme.current.value;
  const v = cur.variables as Record<string, string | number>;
  return {
    dark: cur.dark,
    primary: cur.colors.primary,
    success: cur.colors.success,
    error: cur.colors.error,
    info: cur.colors.info,
    surface: cur.colors.surface,
    onSurface: cur.colors["on-surface"],
    text1: String(v["billy-text-1"] ?? cur.colors["on-surface"]),
    text2: String(v["billy-text-2"] ?? cur.colors["on-surface"]),
    text3: String(v["billy-text-3"] ?? cur.colors["on-surface"]),
    border: String(v["billy-border"] ?? "rgba(0,0,0,.12)"),
  };
};

const baseOption = (): EChartsCoreOption => {
  const tk = themeTokens();
  const base: EChartsCoreOption = {
    animation: !prefersReducedMotion(),
    color: [tk.primary, tk.success, tk.info, tk.error],
    textStyle: { color: tk.text2 },
    legend: { textStyle: { color: tk.text2 }, inactiveColor: tk.text3 },
    tooltip: {
      backgroundColor: tk.surface,
      borderColor: tk.border,
      textStyle: { color: tk.text1 },
    },
  };
  const isCartesian = "xAxis" in props.option || "yAxis" in props.option;
  if (isCartesian) {
    (base as Record<string, unknown>).xAxis = {
      axisLine: { lineStyle: { color: tk.border } },
      axisLabel: { color: tk.text2 },
      splitLine: { show: false },
    };
    (base as Record<string, unknown>).yAxis = {
      axisLine: { show: false },
      axisLabel: { color: tk.text2 },
      splitLine: { lineStyle: { color: tk.border } },
    };
  }
  return base;
};

const render = (): void => {
  if (!chart) return;
  // Reset (notMerge) so switching option shape (e.g. away from axes) never leaves
  // stale components, then layer theme defaults + the caller option.
  chart.setOption(baseOption(), { notMerge: true });
  chart.setOption(props.option, { notMerge: false, lazyUpdate: true });
};

const bindEvents = (): void => {
  if (!chart) return;
  chart.off("click");
  const handlers = props.onEvents;
  if (!handlers) return;
  for (const [name, fn] of Object.entries(handlers)) {
    chart.on(name, fn);
  }
};

onMounted(() => {
  if (!el.value) return;
  chart = echarts.init(el.value, undefined, { renderer: "canvas" });
  render();
  bindEvents();
  ro = new ResizeObserver(() => chart?.resize());
  ro.observe(el.value);
});

watch(
  () => props.onEvents,
  () => bindEvents(),
);

// Recolor + re-option on theme toggle or new data.
watch(
  () => [theme.current.value, props.option],
  () => render(),
  { deep: true },
);

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div
    ref="el"
    class="billy-echart"
    role="img"
    :style="{ width: '100%', height: height ?? '320px' }"
  />
</template>
