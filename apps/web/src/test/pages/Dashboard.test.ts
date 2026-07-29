import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createVuetify } from "vuetify";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import { defineComponent } from "vue";
import { i18n } from "@/plugins/i18n";
import Dashboard from "@/pages/Dashboard.vue";
import * as apiClient from "@/api/client";
import { usePeriodStore } from "@/stores/period";

// EChart is dynamically imported by Dashboard + its chart children and needs a
// real canvas (unavailable in jsdom), so we mock the module to a trivial stub.
vi.mock("@/components/charts/EChart.vue", () => ({
  default: defineComponent({ name: "EChart", template: "<div class='echart-stub' />" }),
}));

// The monthly-counts drilldown uses useRouter() for clickable rows; these
// assertions never navigate, so a minimal router stub silences the warning.
const routerPush = vi.fn();
vi.mock("vue-router", () => ({
  useRouter: () => ({ push: routerPush }),
}));

const vuetify = createVuetify({ components, directives });

const COUNTS = { clients: 7, activeSubscriptions: 3, unbilledTimeEntries: 12, expenses: 5 };
const RECENT = { windowDays: 30, clients: 2, expenses: 1, timeEntries: 4, subscriptions: 0 };

const SUMMARY_WITH_FINANCIALS = {
  year: 2026,
  counts: COUNTS,
  recentActivity: RECENT,
  financials: {
    expenseTotal: { USD: 100000 },
    subscriptionMrr: { USD: 50000 },
    invoiceQuote: {
      invoicedThisMonth: { USD: 250000 },
      collectedThisMonth: { USD: 180000 },
      outstanding: { USD: 70000 },
      overdue: { USD: 30000 },
    },
  },
};

const SUMMARY_NO_FINANCIALS = { year: 2026, counts: COUNTS, recentActivity: RECENT };

const REVENUE = [
  { month: "2026-07", invoiced: { USD: 250000 }, collected: { USD: 180000 }, expenses: { USD: 40000 } },
];
const YEARS = { minYear: 2024, maxYear: 2026 };
const EMPTY_COUNTS: unknown[] = []; // no docs → monthly-counts/heatmap render empty (no EChart)

const mockGet = (summaryResp: unknown, revenueResp: unknown): void => {
  vi.spyOn(apiClient.api, "get").mockImplementation((path: string) => {
    if (path.includes("/years")) return Promise.resolve(YEARS);
    if (path.includes("summary")) return Promise.resolve(summaryResp);
    if (path.includes("monthly-counts")) return Promise.resolve(EMPTY_COUNTS);
    if (path.includes("monthly-totals")) return Promise.resolve(EMPTY_COUNTS); // dashboard PeriodBar
    return Promise.resolve(revenueResp); // revenue-series
  });
  // MonthlyCountsChart fires api.list on mount (drilldown); stub to empty.
  vi.spyOn(apiClient.api, "list").mockResolvedValue({ data: [], meta: { total: 0 } } as never);
};

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    class RO {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  }
});

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  i18n.global.locale.value = "en";
  routerPush.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const mountDashboard = () => {
  return mount(Dashboard, {
    global: {
      // Reuse the beforeEach-activated pinia so tests can read/write the same
      // period store instance the component sees.
      plugins: [pinia, vuetify, i18n],
      stubs: { EChart: { name: "EChart", template: "<div class='echart-stub' />" } },
    },
  });
};

describe("Dashboard — KPI cards", () => {
  it("renders count + financial KPI cards from a mocked summary", async () => {
    mockGet(SUMMARY_WITH_FINANCIALS, REVENUE);

    const wrapper = mountDashboard();
    await flushPromises();

    const text = wrapper.text();
    // Count cards.
    expect(text).toContain("Clients");
    expect(text).toContain("7");
    // Financial cards render (formatted per-currency, USD). Labels are period-
    // scoped now, so they read "Invoiced"/"Collected" (no "this month").
    expect(text).toContain("Invoiced");
    expect(text).toContain("Collected");
    expect(text).toContain("Outstanding");
    expect(text).toContain("Overdue");
    expect(text).toContain("$2,500.00");
    // Recent activity strip.
    expect(text).toContain("Recent activity");
  });

  it("gives the Overdue KPI card an icon (regression: it used to have none)", async () => {
    mockGet(SUMMARY_WITH_FINANCIALS, REVENUE);

    const wrapper = mountDashboard();
    await flushPromises();

    // Every financial KPI card carries an mdi icon; overdue specifically uses
    // mdi-alert-circle-outline.
    const html = wrapper.html();
    expect(html).toContain("mdi-alert-circle-outline");
  });
});

describe("Dashboard — global year drives re-fetch", () => {
  it("re-fetches summary + revenue-series + monthly-counts for the chosen year", async () => {
    mockGet(SUMMARY_WITH_FINANCIALS, REVENUE);

    mountDashboard();
    await flushPromises();

    const getSpy = apiClient.api.get as unknown as ReturnType<typeof vi.fn>;
    const callsFor = (frag: string): unknown[][] =>
      getSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes(frag));

    // Default year = maxYear (2026) drives the first per-year fetch.
    expect(callsFor("summary").some((c) => (c[1] as { year: number }).year === 2026)).toBe(true);

    // Change the GLOBAL year (top-bar store) → each per-year endpoint re-fetches.
    const period = usePeriodStore();
    period.setYear(2024);
    await flushPromises();

    expect(callsFor("summary").some((c) => (c[1] as { year: number }).year === 2024)).toBe(true);
    expect(callsFor("revenue-series").some((c) => (c[1] as { year: number }).year === 2024)).toBe(true);
    expect(callsFor("monthly-counts").some((c) => (c[1] as { year: number }).year === 2024)).toBe(true);
  });
});

describe("Dashboard — SEC5 (financials absent) renders gracefully", () => {
  it("shows counts + activity but no financial cards/charts when financials is omitted", async () => {
    mockGet(SUMMARY_NO_FINANCIALS, []); // revenue-series gated → []

    const wrapper = mountDashboard();
    await flushPromises();

    const text = wrapper.text();
    // Counts + activity present.
    expect(text).toContain("Clients");
    expect(text).toContain("Recent activity");
    // No financial KPI cards (the "Collected" card label is absent; PeriodBar
    // shows month names + counts only, never that card label).
    expect(text).not.toContain("Collected");
    // With financials gated AND empty monthly-counts, no EChart renders at all.
    expect(wrapper.find(".echart-stub").exists()).toBe(false);
  });
});
