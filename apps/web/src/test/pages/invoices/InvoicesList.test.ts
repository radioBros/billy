import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createVuetify } from "vuetify";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import { i18n } from "@/plugins/i18n";
import InvoicesList from "@/pages/invoices/InvoicesList.vue";
import * as apiClient from "@/api/client";

const vuetify = createVuetify({ components, directives });

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ params: {}, query: {} }),
}));

const TOTALS = Array.from({ length: 12 }, (_, i) => ({
  month: `2026-${String(i + 1).padStart(2, "0")}`,
  monthNumber: i + 1,
  count: i === 5 ? 5 : 0,
  totals: i === 5 ? { EUR: 108800 } : {},
}));

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

beforeEach(() => {
  // The period store restores the year from localStorage; clear it so the test
  // deterministically starts on the current calendar year.
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  setActivePinia(createPinia());
  i18n.global.locale.value = "en";
  vi.spyOn(apiClient.api, "get").mockImplementation((path: string) => {
    if (path.includes("/years")) return Promise.resolve({ minYear: 2024, maxYear: 2026 });
    if (path.includes("monthly-totals")) return Promise.resolve(TOTALS);
    if (path.includes("settings")) return Promise.resolve({});
    return Promise.resolve([]);
  });
  // The list itself goes through api.list.
  vi.spyOn(apiClient.api, "list").mockResolvedValue({ data: [], meta: { total: 0 } } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("InvoicesList with PeriodBar", () => {
  it("mounts with the self-fetching PeriodBar and scopes the list query to the year range", async () => {
    const wrapper = mount(InvoicesList, {
      global: { plugins: [createPinia(), vuetify, i18n] },
    });
    await flushPromises();

    // The PeriodBar rendered (13 cells: All year + 12 months) without throwing.
    expect(wrapper.findAll("button.period-cell")).toHaveLength(13);

    // The list query carried the issueDate range bounds for the (default) year.
    const listSpy = apiClient.api.list as unknown as ReturnType<typeof vi.fn>;
    const invoiceCall = listSpy.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes("/v1/invoices"),
    );
    expect(invoiceCall).toBeTruthy();
    const query = invoiceCall![1] as Record<string, string>;
    expect(query["issueDate[gte]"]).toBe("2026-01-01");
    expect(query["issueDate[lte]"]).toBe("2026-12-31");
  });
});
