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
import { apiErrorReason } from "@/utils/validationMessages";
import { useAuthStore } from "@/stores/auth";
import { usePeriodStore } from "@/stores/period";
import { minorToDisplay } from "@/utils/money";
import RevenueExpenseChart from "@/components/dashboard/RevenueExpenseChart.vue";
import MonthlyCountsChart from "@/components/dashboard/MonthlyCountsChart.vue";
import PeriodBar from "@/components/PeriodBar.vue";
import ActivityHeatmap from "@/components/dashboard/ActivityHeatmap.vue";
import EInvoiceNotSentCard from "@/components/dashboard/EInvoiceNotSentCard.vue";
import PageHeader from "@/components/PageHeader.vue";
import { minorToCompact, monthKeyToAbbr } from "@/components/dashboard/chartFormat";
import { useIsMobile } from "@/composables/useIsMobile";
import type { MoneyByCurrency, MonthlyCount, RevenueMonth } from "@/components/dashboard/types";

const EChart = defineAsyncComponent(() => import("@/components/charts/EChart.vue"));

const { t } = useI18n();
const theme = useTheme();
const auth = useAuthStore();
const period = usePeriodStore();
const isMobile = useIsMobile();

/** Chart height: phone charts are shorter so a whole chart fits with its title. */
const chartHeight = computed<string>(() => (isMobile.value ? "240px" : "320px"));

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
  const phone = isMobile.value;
  return {
    tooltip: {
      trigger: "axis",
      valueFormatter: (v: number) => minorToDisplay(v, cur),
    },
    legend: { data: [t("dashboard.chart.invoiced"), t("dashboard.chart.collected")], top: 0 },
    grid: phone
      ? { left: 0, right: 8, bottom: 0, top: 32, containLabel: true }
      : { left: 8, right: 16, bottom: 8, top: 40, containLabel: true },
    // Phones: "Mar" instead of "2026-03" and compact money ticks ("€12K").
    xAxis: { type: "category", boundaryGap: false, data: months.map(monthKeyToAbbr) },
    yAxis: {
      type: "value",
      axisLabel: {
        formatter: (v: number) => (phone ? minorToCompact(v, cur) : minorToDisplay(v, cur)),
      },
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
  const phone = isMobile.value;
  return {
    tooltip: {
      trigger: "item",
      valueFormatter: (v: number) => minorToDisplay(v, cur),
    },
    legend: { bottom: 0, data: [t("dashboard.chart.current"), t("dashboard.chart.overdue")] },
    // Phones: the outstanding total sits in the donut's hole (finance-app style).
    ...(phone
      ? {
          title: {
            text: minorToCompact(outstanding, cur),
            left: "center",
            top: "center",
            textStyle: { fontSize: 20, fontWeight: 700, color: c["on-surface"] },
          },
        }
      : {}),
    series: [
      {
        name: t("dashboard.cards.outstanding"),
        type: "pie",
        radius: phone ? ["62%", "84%"] : ["55%", "78%"],
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

/** Phone KPI tiles step long amounts down a size instead of truncating them. */
const valueSizeClass = (text: string): string => {
  if (text.length > 13) return "kpi-tile__value--xs";
  if (text.length > 10) return "kpi-tile__value--sm";
  return "";
};

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
        ? t("dashboard.loadError", { code: apiErrorReason(err) })
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
        ? t("dashboard.loadError", { code: apiErrorReason(err) })
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
  <div :class="{ 'dash--mobile': isMobile }">
    <!-- Phone: the shared PageHeader title row; the currency picker (only with
         several currencies) gets its own row under the title. -->
    <PageHeader v-if="isMobile" :title="greeting">
      <template v-if="!loading && hasFinancials && currencies.length > 1" #actions>
        <v-select
          v-model="selectedCurrency"
          :items="currencies"
          :label="t('dashboard.currency')"
          density="compact"
          hide-details
          variant="outlined"
          class="dash-currency"
          :aria-label="t('dashboard.currency')"
        />
      </template>
    </PageHeader>
    <div v-else class="d-flex align-center mb-4" style="gap: 16px; flex-wrap: wrap">
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
    <PeriodBar v-if="!loading" v-model:months="selectedMonths" kind="invoices" :class="isMobile ? 'mb-2' : 'mb-5'" />

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
        <v-btn color="primary" size="small" @click="load">{{ t("dashboard.retry") }}</v-btn>
      </template>
    </v-alert>

    <!-- ── Loading skeletons ─────────────────────────────────────────────── -->
    <template v-if="loading && isMobile">
      <div class="kpi-grid mb-3">
        <v-skeleton-loader v-for="n in 4" :key="n" type="list-item-two-line" class="kpi-tile kpi-tile--skeleton" />
      </div>
      <v-skeleton-loader type="image" class="rounded-xl" />
    </template>
    <template v-else-if="loading">
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
      <div class="refetch-slot" :class="isMobile ? 'mb-1' : 'mb-2'">
        <v-progress-linear v-show="yearLoading" indeterminate color="primary" />
      </div>

      <!-- ── Action list: documents not yet sent to SdI (e-invoicing only) ──── -->
      <EInvoiceNotSentCard />

      <!-- ── Phone KPI tiles: a tight 2-column grid, money first. Icon + label on
           top, the value gets the tile's full width (never ellipsized: long
           amounts step the font down instead). ─────────────────────────────── -->
      <template v-if="isMobile">
        <div v-if="hasFinancials" class="kpi-grid mb-2" data-test="kpi-grid-money">
          <div
            v-for="card in moneyCards"
            :key="card.key"
            class="kpi-tile"
            :class="{ 'kpi-tile--alert': card.emphasize }"
          >
            <div class="kpi-tile__head">
              <span class="kpi-tile__icon">
                <v-icon :icon="card.icon" size="18" />
              </span>
              <span class="kpi-tile__label">{{ t(card.labelKey) }}</span>
            </div>
            <div class="kpi-tile__value" :class="valueSizeClass(money(card.minor))">
              {{ money(card.minor) }}
            </div>
          </div>
        </div>
        <div class="kpi-grid mb-3" data-test="kpi-grid-counts">
          <div v-for="card in countCards" :key="card.key" class="kpi-tile">
            <div class="kpi-tile__head">
              <span class="kpi-tile__icon">
                <v-icon :icon="card.icon" size="18" />
              </span>
              <span class="kpi-tile__label">{{ t(card.labelKey) }}</span>
            </div>
            <div class="kpi-tile__value">{{ card.value }}</div>
          </div>
        </div>
      </template>

      <!-- ── KPI: counts (year-scoped) ─────────────────────────────────────── -->
      <v-row v-if="!isMobile" class="mb-1">
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
      <v-row v-if="hasFinancials && !isMobile" class="mb-2">
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
      <section v-if="isMobile" class="dash-section activity-m" data-test="activity-mobile">
        <div class="dash-section__head">
          <span class="dash-section__title">{{ t("dashboard.activity.title") }}</span>
          <span class="dash-section__hint">{{ t("dashboard.activity.window", { days: activityWindow }) }}</span>
        </div>
        <div class="activity-m__grid">
          <div v-for="item in activityItems" :key="item.key" class="activity-m__item">
            <span class="activity-m__icon"><v-icon :icon="item.icon" size="18" /></span>
            <div class="activity-m__text">
              <div class="activity-m__value">{{ item.value }}</div>
              <div class="activity-m__label">{{ t(item.labelKey) }}</div>
            </div>
          </div>
        </div>
      </section>
      <v-card v-else variant="flat" class="my-4">
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
      <v-row v-if="hasFinancials" class="dash-chart-row">
        <v-col cols="12" md="8">
          <v-card variant="flat" border class="h-100 dash-card">
            <v-card-title class="text-subtitle-1 font-weight-medium">
              {{ t("dashboard.chart.revenueTitle", { year: selectedYear }) }}
            </v-card-title>
            <v-card-text>
              <EChart v-if="hasRevenue" :option="revenueChartOption" :height="chartHeight" />
              <div v-else class="chart-empty">
                <v-icon icon="mdi-chart-line" size="36" class="mb-2" />
                <div class="text-body-2">{{ t("dashboard.chart.revenueEmpty") }}</div>
              </div>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" md="4">
          <v-card variant="flat" border class="h-100 dash-card">
            <v-card-title class="text-subtitle-1 font-weight-medium">
              {{ t("dashboard.chart.outstandingTitle") }}
            </v-card-title>
            <v-card-text>
              <EChart v-if="!outstandingEmpty" :option="outstandingChartOption" :height="isMobile ? '220px' : '320px'" />
              <div v-else class="chart-empty">
                <v-icon icon="mdi-check-circle-outline" size="36" class="mb-2" />
                <div class="text-body-2">{{ t("dashboard.chart.outstandingEmpty") }}</div>
              </div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <!-- ── Revenue / expense chart ──────────────────────────── -->
      <v-card v-if="hasFinancials" variant="flat" border class="dash-card" :class="isMobile ? 'mt-3' : 'mt-4'">
        <v-card-title class="text-subtitle-1 font-weight-medium">
          {{ t("dashboard.chart.revenueExpenseTitle", { year: selectedYear }) }}
        </v-card-title>
        <v-card-text>
          <RevenueExpenseChart :rows="revenue" :currency="currency" />
        </v-card-text>
      </v-card>

      <!-- ── Monthly counts + drilldown (not gated) ────────────────────────── -->
      <div :class="isMobile ? 'mt-3' : 'mt-4'">
        <MonthlyCountsChart
          class="dash-card"
          v-model:months="selectedMonths"
          :rows="monthlyCounts"
          :year="selectedYear"
        />
      </div>

      <!-- ── Activity heatmap (not gated) ──────────────────────────────────── -->
      <v-card variant="flat" border class="dash-card" :class="isMobile ? 'mt-3' : 'mt-4'">
        <v-card-title class="text-subtitle-1 font-weight-medium">
          {{ t("dashboard.heatmap.title", { year: selectedYear }) }}
        </v-card-title>
        <v-card-text :class="{ 'pb-0': !isMobile }">
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

/* ── Phone (< 600px) ─────────────────────────────────────────────────────── */
.dash-currency {
  min-width: 120px;
  max-width: 160px;
}
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.kpi-tile {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--v-billy-border);
  border-radius: 16px;
  background: rgb(var(--v-theme-surface));
}
.kpi-tile--skeleton {
  padding: 0;
  overflow: hidden;
}
.kpi-tile__head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}
.kpi-tile__icon {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 10px;
  color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.12);
}
.kpi-tile__label {
  min-width: 0;
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--v-billy-text-3);
  overflow-wrap: anywhere;
  /* Two lines reserved so every value starts at the same height. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.4em;
  padding-top: 1px;
}
.kpi-tile__value {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--v-billy-text-1, rgb(var(--v-theme-on-surface)));
}
.kpi-tile__value--sm {
  font-size: 1.0625rem;
}
.kpi-tile__value--xs {
  font-size: 0.9375rem;
}
/* Overdue > 0: a tinted alert tile (the desktop solid-red card is too loud on a phone grid). */
.kpi-tile--alert {
  border-color: rgba(var(--v-theme-error), 0.45);
  background: rgba(var(--v-theme-error), 0.08);
}
.kpi-tile--alert .kpi-tile__icon {
  color: rgb(var(--v-theme-error));
  background: rgba(var(--v-theme-error), 0.16);
}
.kpi-tile--alert .kpi-tile__label,
.kpi-tile--alert .kpi-tile__value {
  color: rgb(var(--v-theme-error));
}

.dash-section {
  border: 1px solid var(--v-billy-border);
  border-radius: 16px;
  background: rgb(var(--v-theme-surface));
  padding: 12px 14px 14px;
  margin-bottom: 12px;
}
.dash-section__head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin-bottom: 10px;
}
.dash-section__title {
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--v-billy-text-3);
}
.dash-section__hint {
  font-size: 0.75rem;
  color: var(--v-billy-text-3);
}
.activity-m__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 10px;
}
.activity-m__item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.activity-m__icon {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  color: rgb(var(--v-theme-secondary));
  background: rgba(var(--v-theme-secondary), 0.12);
}
.activity-m__text {
  min-width: 0;
}
.activity-m__value {
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.activity-m__label {
  font-size: 0.75rem;
  line-height: 1.25;
  color: var(--v-billy-text-2);
  overflow-wrap: anywhere;
}
/* Chart cards stack with a 12px rhythm (v-row's 24px gutters are desktop-sized). */
.dash--mobile .dash-chart-row {
  margin-top: -6px;
  margin-bottom: -6px;
}
.dash--mobile .dash-chart-row > .v-col {
  padding-top: 6px;
  padding-bottom: 6px;
}
.dash--mobile .chart-empty {
  height: 200px;
}
/* Phone section cards: 16px radius, a light inline title instead of the
   desktop grey title band — reads like one calm feed of cards. */
.dash--mobile :deep(.v-card.dash-card) {
  border-radius: 16px !important;
}
.dash--mobile :deep(.dash-card > .v-card-title) {
  min-height: 0;
  padding: 14px 14px 2px;
  background-color: transparent;
  font-size: 0.9375rem !important; /* beats the global .text-subtitle-1 */
  font-weight: 700 !important;
  letter-spacing: -0.005em;
}
.dash--mobile :deep(.dash-card > .v-card-text) {
  padding: 8px 12px 12px;
}
</style>
