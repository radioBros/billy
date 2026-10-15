import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import QuoteDetail from "@/pages/quotes/QuoteDetail.vue";
import DocumentActions from "@/components/DocumentActions.vue";
import en from "@/locales/en.json";

const i18n = createI18n({ legacy: false, locale: "en", messages: { en }, missingWarn: false, fallbackWarn: false });

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { id: "q_1" } }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));

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

const quote = {
  id: "q_1",
  version: 3,
  quoteNumber: "Q-2026-0001",
  status: "sent",
  clientId: "cl_1",
  currency: "EUR",
  issueDate: "2026-07-12",
  expiryDate: "2026-08-19",
  lineItems: [
    { description: "Discovery workshop", quantity: 1, unitPriceMinor: 150000, lineTotalMinor: 183000 },
    { description: "Prototype", quantity: 2, unitPriceMinor: 80000, lineTotalMinor: 175680 },
  ],
  subtotalMinor: 310000,
  taxMinor: 64680,
  grandTotalMinor: 358680,
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/quotes/q_1")) return jsonResponse({ data: quote, meta: {}, error: null });
      return jsonResponse({ data: [], meta: { page: 1, limit: 50, total: 0, pageCount: 1 }, error: null });
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

describe("QuoteDetail", () => {
  it("desktop: keeps the line-item table and the inline lifecycle buttons", async () => {
    const wrapper = mount(QuoteDetail, { global: { plugins: [vuetifyAt(1280), i18n] } });
    await flushPromises();

    expect(wrapper.find("table").exists()).toBe(true);
    expect(wrapper.find(".dm-hero").exists()).toBe(false);
    expect(wrapper.findComponent(DocumentActions).exists()).toBe(true);
    const labels = wrapper.findAll("button").map((b) => b.text());
    expect(labels.some((l) => l.includes(en.quotes.accept))).toBe(true);
    expect(labels.some((l) => l.includes(en.quotes.decline))).toBe(true);
    wrapper.unmount();
  });

  it("phone: hero summary, prominent Accept, and line cards instead of a table", async () => {
    const wrapper = mount(QuoteDetail, { global: { plugins: [vuetifyAt(390), i18n] } });
    await flushPromises();

    const hero = wrapper.find(".dm-hero");
    expect(hero.exists()).toBe(true);
    expect(hero.text()).toContain("Q-2026-0001");
    expect(hero.find(".dm-hero__total").text()).toContain("3,586.80");
    // No wide table on phones — one card per line, plus the totals block.
    expect(wrapper.find("table").exists()).toBe(false);
    expect(wrapper.findAll(".dm-line")).toHaveLength(2);
    expect(wrapper.find(".dm-totals").exists()).toBe(true);
    // Lifecycle: Accept (primary) + Decline share the action row; DocumentActions stays.
    const primary = wrapper.find(".dm-actions__primary");
    expect(primary.text()).toContain(en.quotes.accept);
    expect(primary.text()).toContain(en.quotes.decline);
    expect(wrapper.findComponent(DocumentActions).exists()).toBe(true);
    wrapper.unmount();
  });
});
