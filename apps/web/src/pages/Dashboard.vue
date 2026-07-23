<script setup lang="ts">
/**
 * Billy dashboard — per-year KPI cards + charts + a rolling recent-activity strip.
 *
 * Data contract:
 *   GET /v1/dashboard/years          → { minYear, maxYear }
 *   GET /v1/dashboard/summary?year=  → counts, recentActivity(rolling-30d), financials?
 *   GET /v1/dashboard/revenue-series?year= → 12× { month, invoiced, collected, expenses }
 *   GET /v1/dashboard/monthly-counts?year= → 12× { month, monthNumber, counts, total }
 *
 * A YEAR SELECTOR drives EVERY chart + KPI: changing it re-fetches summary,
 * revenue-series and monthly-counts for that year. recentActivity is NOT
 * year-filtered (it stays rolling-30d) — that strip is left untouched.
 *
 * `financials` (and a non-empty revenue series) are gated on
 * `canViewFinancialTotals`. When absent the dashboard renders counts + activity +
 * the (non-gated) monthly-counts/heatmap only — no financial cards, no
 * revenue/expense charts — and still looks intentional.
 *
 * Money is integer minor units, per currency, NEVER blended. A single currency
 * selector drives the financial KPI cards + revenue charts; we never sum currencies.
 *
 * ECharts is loaded through dynamic imports (defineAsyncComponent) inside the chart
 * components so the ~1MB library is a separate lazy chunk, out of the initial PWA
 * bundle. Big pieces are split into components/dashboard/* to keep this page flat.
 */
import { computed, defineAsyncComponent, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useTheme } from "vuetify";
import { api, ApiError } from "@/api/client";
import { useAuthStore } from "@/stores/auth";
import { usePeriodStore } from "@/stores/period";
import { minorToDisplay } from "@/utils/money";
import RevenueExpenseChart from "@/components/dashboard/RevenueExpenseChart.vue";
import MonthlyCountsChart from "@/components/dashboard/MonthlyCountsChart.vue";
import PeriodBar from "@/components/PeriodBar.vue";
import ActivityHeatmap from "@/components/dashboard/ActivityHeatmap.vue";
import type { MoneyByCurrency, MonthlyCount, RevenueMonth } from "@/components/dashboard/types";

const EChart = defineAsyncComponent(() => import("@/components/charts/EChart.vue"));

const { t } = useI18n();
const theme = useTheme();
const auth = useAuthStore();
const period = usePeriodStore();

// ── Contract shapes ──────────────────────────────────────────────────────────
interface DashboardSummary {
  year?: number;
  counts: {
    clients: number;
    activeSubscriptions: number;
    unbilledTimeEntries: number;
    expenses: number;
  };
  recentActivity: {
    windowDays: number;
    clients: number;
    expenses: number;
    timeEntries: number;
    subscriptions: number;
  };
  financials?: {
    expenseTotal: MoneyByCurrency;
    subscriptionMrr: MoneyByCurrency;
    invoiceQuote: {
      invoicedThisMonth: MoneyByCurrency;
      collectedThisMonth: MoneyByCurrency;
      outstanding: MoneyByCurrency;
      overdue: MoneyByCurrency;
    };
  };
}

const greeting = computed<string>(() =>
  auth.principal?.displayName
    ? t("dashboard.welcomeNamed", { name: auth.principal.displayName })
    : t("dashboard.welcome"),
);

// ── State ────────────────────────────────────────────────────────────────────
const loading = ref(true); // initial load (years + first year's data)
const yearLoading = ref(false); // re-fetch on year change (keeps layout in place)
const errorMessage = ref<string | null>(null);
const summary = ref<DashboardSummary | null>(null);
const revenue = ref<RevenueMonth[]>([]);
const monthlyCounts = ref<MonthlyCount[]>([]);
const selectedCurrency = ref<string | null>(null);

// The YEAR is global (top-bar store). The dashboard owns only its MONTH subset:
// empty ⇒ whole year; selecting months re-scopes the KPI cards + summary and
// dims (does not filter) the 12-month trend charts.
const selectedMonths = ref<number[]>([]);
const selectedYear = computed<number>(() => period.year);

const financials = computed(() => summary.value?.financials ?? null);

/** All currencies present across financial maps + the revenue series (sorted). */
const currencies = computed<string[]>(() => {
  const set = new Set<string>();
  const f = financials.value;
  if (f) {
    for (const map of [
      f.expenseTotal,
      f.subscriptionMrr,
      f.invoiceQuote.invoicedThisMonth,
      f.invoiceQuote.collectedThisMonth,
      f.invoiceQuote.outstanding,
      f.invoiceQuote.overdue,
    ]) {
      for (const c of Object.keys(map)) set.add(c);
    }
  }
  for (const m of revenue.value) {
    for (const c of Object.keys(m.invoiced)) set.add(c);
    for (const c of Object.keys(m.collected)) set.add(c);
    for (const c of Object.keys(m.expenses ?? {})) set.add(c);
  }
  return Array.from(set).sort();
});

/** The active currency for the financial cards + charts (never blends). */
const currency = computed<string | null>(
  () => selectedCurrency.value ?? currencies.value[0] ?? null,
);

const hasFinancials = computed<boolean>(() => financials.value !== null);
const hasRevenue = computed<boolean>(
  () =>
    revenue.value.some(
      (m) => Object.keys(m.invoiced).length > 0 || Object.keys(m.collected).length > 0,
    ),
);

const amt = (map: MoneyByCurrency | undefined): number | undefined => {
  if (!map || !currency.value) return undefined;
  return map[currency.value];
};

// ── KPI card models ────────────────────────────────────────────────────────
interface CountCard {
  key: string;
  labelKey: string;
  icon: string;
  value: number;
}

const countCards = computed<CountCard[]>(() => {
  const c = summary.value?.counts;
  if (!c) return [];
  return [
    { key: "clients", labelKey: "dashboard.cards.clients", icon: "mdi-account-group-outline", value: c.clients },
    { key: "subs", labelKey: "dashboard.cards.activeSubscriptions", icon: "mdi-refresh", value: c.activeSubscriptions },
    { key: "unbilled", labelKey: "dashboard.cards.unbilledTimeEntries", icon: "mdi-clock-outline", value: c.unbilledTimeEntries },
    { key: "expenses", labelKey: "dashboard.cards.expenses", icon: "mdi-cash-multiple", value: c.expenses },
  ];
});

interface MoneyCard {
  key: string;
  labelKey: string;
  icon: string;
  minor: number | undefined;
  emphasize?: boolean;
}

const moneyCards = computed<MoneyCard[]>(() => {
  const f = financials.value;
  if (!f) return [];
  const iq = f.invoiceQuote;
  const overdue = amt(iq.overdue);
  return [
    { key: "invoiced", labelKey: "dashboard.cards.invoicedThisMonth", icon: "mdi-file-document-outline", minor: amt(iq.invoicedThisMonth) },
    { key: "collected", labelKey: "dashboard.cards.collectedThisMonth", icon: "mdi-cash-check", minor: amt(iq.collectedThisMonth) },
    { key: "outstanding", labelKey: "dashboard.cards.outstanding", icon: "mdi-timer-sand", minor: amt(iq.outstanding) },
    // OVERDUE: the one KPI that used to lack an icon — mdi-alert-circle-outline.
    { key: "overdue", labelKey: "dashboard.cards.overdue", icon: "mdi-alert-circle-outline", minor: overdue, emphasize: (overdue ?? 0) > 0 },
  ];
});

const activityItems = computed(() => {
  const a = summary.value?.recentActivity;
  if (!a) return [];
  return [
    { key: "clients", labelKey: "dashboard.activity.clients", icon: "mdi-account-plus-outline", value: a.clients },
    { key: "expenses", labelKey: "dashboard.activity.expenses", icon: "mdi-cash-plus", value: a.expenses },
    { key: "timeEntries", labelKey: "dashboard.activity.timeEntries", icon: "mdi-clock-plus-outline", value: a.timeEntries },
    { key: "subscriptions", labelKey: "dashboard.activity.subscriptions", icon: "mdi-refresh", value: a.subscriptions },
  ];
});

const activityWindow = computed<number>(() => summary.value?.recentActivity.windowDays ?? 30);

// ── Chart options (theme-aware colors are injected by EChart.vue) ────────────
const money = (minor: number | undefined): string => {
  return minorToDisplay(minor, currency.value);
};

/** Per-year revenue LINE chart: invoiced vs collected across all 12 months. */
const revenueChartOption = computed(() => {
  const cur = currency.value;
  const rows = revenue.value;
  const months = rows.map((r) => r.month);
  const invoiced = rows.map((r) => (cur ? (r.invoiced[cur] ?? 0) : 0));
  const collected = rows.map((r) => (cur ? (r.collected[cur] ?? 0) : 0));
  const c = theme.current.value.colors;
  return {
    tooltip: {
      trigger: "axis",
      valueFormatter: (v: number) => minorToDisplay(v, cur),
    },
    legend: { data: [t("dashboard.chart.invoiced"), t("dashboard.chart.collected")], top: 0 },
    grid: { left: 8, right: 16, bottom: 8, top: 40, containLabel: true },
    xAxis: { type: "category", boundaryGap: false, data: months },
    yAxis: {
      type: "value",
      axisLabel: { formatter: (v: number) => minorToDisplay(v, cur) },
    },
    series: [
      {
        name: t("dashboard.chart.invoiced"),
        type: "line",
        smooth: true,
        showSymbol: false,
        data: invoiced,
        itemStyle: { color: c.primary },
        areaStyle: { opacity: 0.14 },
      },
      {
        name: t("dashboard.chart.collected"),
        type: "line",
        smooth: true,
        showSymbol: false,
        data: collected,
        itemStyle: { color: c.success },
        areaStyle: { opacity: 0.14 },
      },
    ],
  };
});

const outstandingChartOption = computed(() => {
  const f = financials.value;
  const cur = currency.value;
  const c = theme.current.value.colors;
  const outstanding = (cur && f ? f.invoiceQuote.outstanding[cur] : 0) ?? 0;
  const overdue = (cur && f ? f.invoiceQuote.overdue[cur] : 0) ?? 0;
  // "Outstanding" includes overdue; show the current (not-yet-overdue) slice vs overdue.
  const current = Math.max(outstanding - overdue, 0);
  return {
    tooltip: {
      trigger: "item",
      valueFormatter: (v: number) => minorToDisplay(v, cur),
    },
    legend: { bottom: 0, data: [t("dashboard.chart.current"), t("dashboard.chart.overdue")] },
    series: [
      {
        name: t("dashboard.cards.outstanding"),
        type: "pie",
        radius: ["55%", "78%"],
        avoidLabelOverlap: false,
        label: { show: false },
        data: [
          { value: current, name: t("dashboard.chart.current"), itemStyle: { color: c.primary } },
          { value: overdue, name: t("dashboard.chart.overdue"), itemStyle: { color: c.error } },
        ],
      },
    ],
  };
});

const outstandingEmpty = computed<boolean>(() => {
  const f = financials.value;
  const cur = currency.value;
  if (!f || !cur) return true;
  return ((f.invoiceQuote.outstanding[cur] ?? 0) + (f.invoiceQuote.overdue[cur] ?? 0)) === 0;
});

// ── Fetch ────────────────────────────────────────────────────────────────────
// The summary is period-scoped (year + optional month subset) so the KPI cards
// react to the month bar. The two 12-month datasets (revenue-series,
// monthly-counts) are always fetched for the WHOLE year — the charts dim the
// unselected months rather than dropping them (a collapsed trend line is
// useless), so their fetch depends only on the year.
const loadData = async (): Promise<void> => {
  const year = period.year;
  const months = selectedMonths.value.length > 0 ? selectedMonths.value.join(",") : undefined;
  const [s, r, mc] = await Promise.all([
    api.get<DashboardSummary>("/v1/dashboard/summary", { year, months }),
    api
      .get<RevenueMonth[]>("/v1/dashboard/revenue-series", { year })
      .catch(() => [] as RevenueMonth[]),
    api
      .get<MonthlyCount[]>("/v1/dashboard/monthly-counts", { year })
      .catch(() => [] as MonthlyCount[]),
  ]);
  summary.value = s;
  revenue.value = Array.isArray(r) ? r : [];
  monthlyCounts.value = Array.isArray(mc) ? mc : [];
};

const load = async (): Promise<void> => {
  loading.value = true;
  errorMessage.value = null;
  try {
    await period.loadRange();
    await loadData();
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError
        ? t("dashboard.loadError", { code: err.code })
        : t("dashboard.loadErrorGeneric");
  } finally {
    loading.value = false;
  }
};

const reload = async (): Promise<void> => {
  yearLoading.value = true;
  errorMessage.value = null;
  try {
    await loadData();
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError
        ? t("dashboard.loadError", { code: err.code })
        : t("dashboard.loadErrorGeneric");
  } finally {
    yearLoading.value = false;
  }
};

// Global year change resets the month selection (months are year-scoped) and
// re-fetches everything. A month-bar change re-fetches only the summary path.
watch(
  () => period.year,
  () => {
    selectedMonths.value = [];
    if (!loading.value) void reload();
  },
);
watch(
  selectedMonths,
  () => {
    if (!loading.value) void reload();
  },
  { deep: true },
);

onMounted(() => {
  void load();
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 16px; flex-wrap: wrap">
      <h1 class="text-h5">{{ greeting }}</h1>
      <v-spacer />
      <v-select
        v-if="!loading && hasFinancials && currencies.length > 1"
        v-model="selectedCurrency"
        :items="currencies"
        :label="t('dashboard.currency')"
        density="compact"
        hide-details
        variant="outlined"
        style="max-width: 160px"
        :aria-label="t('dashboard.currency')"
      />
    </div>

    <!-- Month bar: the year is global (top bar); this picks the month subset that
         scopes the KPI cards + summary. Charts dim unselected months. Uses the
         invoices totals as the revenue-representative bar (same nice bar as the
         list pages). -->
    <PeriodBar v-if="!loading" v-model:months="selectedMonths" kind="invoices" class="mb-5" />

    <v-alert
      v-if="errorMessage"
      type="error"
      variant="tonal"
      density="compact"
      class="mb-6"
      role="alert"
    >
      {{ errorMessage }}
      <template #append>
        <v-btn variant="text" size="small" @click="load">{{ t("dashboard.retry") }}</v-btn>
      </template>
    </v-alert>

    <!-- ── Loading skeletons ─────────────────────────────────────────────── -->
    <template v-if="loading">
      <v-row class="mb-2">
        <v-col v-for="n in 4" :key="n" cols="12" sm="6" md="3">
          <v-skeleton-loader type="article" class="rounded-lg" />
        </v-col>
      </v-row>
      <v-row>
        <v-col cols="12" md="8"><v-skeleton-loader type="image" class="rounded-lg" /></v-col>
        <v-col cols="12" md="4"><v-skeleton-loader type="image" class="rounded-lg" /></v-col>
      </v-row>
    </template>

    <template v-else-if="summary">
      <!-- Year-scoped datasets refresh in place; a thin bar signals the re-fetch.
           The slot is ALWAYS present at a fixed height (only the bar's opacity
           toggles), so showing/hiding it can't reflow the page — that reflow was
           flashing the scrollbar when a period committed. -->
      <div class="refetch-slot mb-2">
        <v-progress-linear v-show="yearLoading" indeterminate color="primary" />
      </div>

      <!-- ── KPI: counts (year-scoped) ─────────────────────────────────────── -->
      <v-row class="mb-1">
        <v-col v-for="card in countCards" :key="card.key" cols="12" sm="6" md="3">
          <v-card class="kpi-card h-100" variant="flat" border>
            <v-card-text class="d-flex align-start" style="gap: 14px">
              <v-avatar color="primary" variant="tonal" size="48" rounded="lg">
                <v-icon :icon="card.icon" size="30" />
              </v-avatar>
              <div class="kpi-body">
                <div class="text-caption text-uppercase kpi-label kpi-label--fixed">{{ t(card.labelKey) }}</div>
                <div class="text-h5 font-weight-bold">{{ card.value }}</div>
              </div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <!-- ── KPI: financials (year-scoped) ─────────────────────── -->
      <v-row v-if="hasFinancials" class="mb-2">
        <v-col v-for="card in moneyCards" :key="card.key" cols="12" sm="6" md="3">
          <v-card
            class="kpi-card h-100"
            :class="{ 'kpi-emphasize': card.emphasize }"
            variant="flat"
            border
            :color="card.emphasize ? 'error' : undefined"
          >
            <v-card-text class="d-flex align-start" style="gap: 14px">
              <!-- On the red (emphasized) card, a tonal error avatar renders an
                   error-on-error icon that's invisible. Use a solid light chip so
                   the icon (error-coloured) stays clearly visible; the normal card
                   keeps the tonal primary avatar. -->
              <v-avatar
                v-if="card.emphasize"
                color="white"
                variant="flat"
                size="48"
                rounded="lg"
              >
                <v-icon :icon="card.icon" color="error" size="30" />
              </v-avatar>
              <v-avatar
                v-else
                color="primary"
                variant="tonal"
                size="48"
                rounded="lg"
              >
                <v-icon :icon="card.icon" size="30" />
              </v-avatar>
              <div class="kpi-body text-truncate">
                <div
                  class="text-caption text-uppercase kpi-label--fixed"
                  :class="card.emphasize ? 'kpi-label-emphasize' : 'kpi-label'"
                >
                  {{ t(card.labelKey) }}
                </div>
                <div class="text-h6 font-weight-bold text-truncate">{{ money(card.minor) }}</div>
              </div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <!-- ── Recent activity strip (rolling-30d, NOT year-filtered) ────────── -->
      <v-card variant="flat" class="my-4">
        <v-card-title class="text-subtitle-1 font-weight-medium d-flex align-center">
          {{ t("dashboard.activity.title") }}
          <span class="text-caption kpi-label ml-2">
            {{ t("dashboard.activity.window", { days: activityWindow }) }}
          </span>
        </v-card-title>
        <v-card-text>
          <v-row>
            <v-col v-for="item in activityItems" :key="item.key" cols="6" md="3">
              <div class="d-flex align-center" style="gap: 12px">
                <v-icon
                  :icon="item.icon"
                  color="secondary"
                  size="34"
                />
                <div>
                  <div class="text-h6 font-weight-bold">{{ item.value }}</div>
                  <div class="text-caption kpi-label">{{ t(item.labelKey) }}</div>
                </div>
              </div>
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- ── Financial charts ─────────────────────────────────── -->
      <v-row v-if="hasFinancials">
        <v-col cols="12" md="8">
          <v-card variant="flat" border class="h-100">
            <v-card-title class="text-subtitle-1 font-weight-medium">
              {{ t("dashboard.chart.revenueTitle", { year: selectedYear }) }}
            </v-card-title>
            <v-card-text>
              <EChart v-if="hasRevenue" :option="revenueChartOption" height="320px" />
              <div v-else class="chart-empty">
                <v-icon icon="mdi-chart-line" size="36" class="mb-2" />
                <div class="text-body-2">{{ t("dashboard.chart.revenueEmpty") }}</div>
              </div>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" md="4">
          <v-card variant="flat" border class="h-100">
            <v-card-title class="text-subtitle-1 font-weight-medium">
              {{ t("dashboard.chart.outstandingTitle") }}
            </v-card-title>
            <v-card-text>
              <EChart v-if="!outstandingEmpty" :option="outstandingChartOption" height="320px" />
              <div v-else class="chart-empty">
                <v-icon icon="mdi-check-circle-outline" size="36" class="mb-2" />
                <div class="text-body-2">{{ t("dashboard.chart.outstandingEmpty") }}</div>
              </div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <!-- ── Revenue / expense chart ──────────────────────────── -->
      <v-card v-if="hasFinancials" variant="flat" border class="mt-4">
        <v-card-title class="text-subtitle-1 font-weight-medium">
          {{ t("dashboard.chart.revenueExpenseTitle", { year: selectedYear }) }}
        </v-card-title>
        <v-card-text>
          <RevenueExpenseChart :rows="revenue" :currency="currency" />
        </v-card-text>
      </v-card>

      <!-- ── Monthly counts + drilldown (not gated) ────────────────────────── -->
      <div class="mt-4">
        <MonthlyCountsChart
          v-model:months="selectedMonths"
          :rows="monthlyCounts"
          :year="selectedYear"
        />
      </div>

      <!-- ── Activity heatmap (not gated) ──────────────────────────────────── -->
      <v-card variant="flat" border class="mt-4">
        <v-card-title class="text-subtitle-1 font-weight-medium">
          {{ t("dashboard.heatmap.title", { year: selectedYear }) }}
        </v-card-title>
        <v-card-text class="pb-0">
          <ActivityHeatmap :rows="monthlyCounts" />
        </v-card-text>
      </v-card>

    </template>
  </div>
</template>

<style scoped>
/* Fixed-height slot for the re-fetch bar so toggling it never reflows the page. */
.refetch-slot {
  height: 4px;
}
.kpi-card {
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;
}
.kpi-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
}
.kpi-label {
  color: var(--v-billy-text-2);
  letter-spacing: 0.06em;
}
/* Keep the icon, label and value at the SAME vertical positions across all KPI
   cards regardless of whether the label is one or two lines: the card content is
   top-aligned (align-start) and the label reserves a fixed two-line block, so the
   value always begins at the same Y. */
.kpi-body {
  min-width: 0;
  flex: 1;
}
.kpi-label--fixed {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.2em; /* reserve two lines so the value below never shifts */
  line-height: 1.1;
}
/* On the emphasized (error-filled) card, inherit on-error contrast instead of the
   muted text ramp, which would be low-contrast on a saturated red surface. */
.kpi-label-emphasize {
  opacity: 0.85;
  letter-spacing: 0.06em;
}
.chart-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 320px;
  text-align: center;
  color: var(--v-billy-text-3);
}
@media (prefers-reduced-motion: reduce) {
  .kpi-card {
    transition: none;
  }
}
</style>
