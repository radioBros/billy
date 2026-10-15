import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import RecurringProfileDetail from "@/pages/recurring-profiles/RecurringProfileDetail.vue";
import en from "@/locales/en.json";

const i18n = createI18n({ legacy: false, locale: "en", messages: { en }, missingWarn: false, fallbackWarn: false });

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { id: "rp_1" } }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));

/** Minimal RouterLink stand-in: renders an <a> and exposes the target route. */
const RouterLinkStub = defineComponent({
  props: { to: { type: Object, required: true } },
  setup(props, { slots }) {
    return () => h("a", { "data-to": JSON.stringify(props.to) }, slots.default?.());
  },
});

/** Vuetify reads the viewport width once, when the instance is created. */
const vuetifyAt = (width: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  return createVuetify({ components, directives });
};

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as unknown as { visualViewport?: unknown }).visualViewport ??= {
    width: 1024,
    height: 768,
    offsetLeft: 0,
    offsetTop: 0,
    scale: 1,
    addEventListener() {},
    removeEventListener() {},
  };
});

const profile = {
  id: "rp_1",
  version: 4,
  status: "active",
  documentType: "invoice",
  clientId: "cl_1",
  currency: "EUR",
  interval: "monthly",
  intervalCount: 1,
  dayOfMonth: null,
  startDate: "2026-08-01",
  nextRunAt: "2026-09-01",
  lastRunAt: "2026-08-01T13:45:40.061Z",
  endDate: null,
  maxOccurrences: null,
  occurrencesGenerated: 1,
  subject: "Retainer",
  notes: null,
  lineItems: [{ description: "Monthly retainer", quantity: 1, unitPriceMinor: 150000, lineTotalMinor: 150000 }],
  subtotalMinor: 150000,
  taxMinor: 0,
  grandTotalMinor: 150000,
  createdInvoiceIds: ["inv_1"],
  autoSend: null,
};

const generated = { id: "inv_1", invoiceNumber: "17/2026", status: "finalized", currency: "EUR", issueDate: "2026-08-01", dueDate: "2026-08-31", grandTotalMinor: 150000, amountDueMinor: 150000 };

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const list = (data: unknown[]): Response =>
  jsonResponse({ data, meta: { page: 1, limit: 200, total: data.length, pageCount: 1 }, error: null });

beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/recurring-profiles/rp_1")) return jsonResponse({ data: profile, meta: {}, error: null });
      if (url.includes("/v1/clients/cl_1")) return jsonResponse({ data: { id: "cl_1", displayName: "Globex Srl" }, meta: {}, error: null });
      if (url.includes("/v1/invoices?")) return list([generated]);
      return list([]);
    }),
  );
});
afterAll(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("RecurringProfileDetail", () => {
  it("desktop: generated documents stay a data table", async () => {
    const wrapper = mount(RecurringProfileDetail, {
      global: { plugins: [vuetifyAt(1280), i18n], stubs: { RouterLink: RouterLinkStub } },
    });
    await flushPromises();

    expect(wrapper.find(".dm-hero").exists()).toBe(false);
    expect(wrapper.find(".v-data-table").text()).toContain("17/2026");
    expect(wrapper.find("[data-test='recurring-edit']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("phone: hero + Generate now, and each generated document is a card linking to it", async () => {
    const wrapper = mount(RecurringProfileDetail, {
      global: { plugins: [vuetifyAt(390), i18n], stubs: { RouterLink: RouterLinkStub } },
    });
    await flushPromises();

    expect(wrapper.find(".dm-hero").text()).toContain("Globex Srl");
    expect(wrapper.find(".dm-actions__primary").text()).toContain(en.recurring.generateNow);
    expect(wrapper.find(".v-data-table").exists()).toBe(false);
    const cards = wrapper.findAll(".dm-doc");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text()).toContain("17/2026");
    expect(JSON.parse(cards[0]!.attributes("data-to") ?? "{}")).toEqual({ name: "invoice-detail", params: { id: "inv_1" } });
    // Edit stays reachable (title-row icon) with its data-test hook.
    expect(wrapper.find("[data-test='recurring-edit']").exists()).toBe(true);
    wrapper.unmount();
  });
});
