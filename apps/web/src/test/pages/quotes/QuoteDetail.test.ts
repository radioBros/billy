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

const routerPush = vi.hoisted(() => vi.fn());
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { id: "q_1" } }),
  useRouter: () => ({ back: vi.fn(), push: routerPush }),
}));
// Auto-accept the confirmation dialog.
vi.mock("@/composables/useConfirm", () => ({ confirm: vi.fn(async () => true) }));

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
  routerPush.mockReset();
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

  it("desktop: the converted alert names the invoice by NUMBER, never its raw id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/v1/quotes/q_1"))
          return jsonResponse({ data: { ...quote, status: "converted", convertedInvoiceId: "inv_77" }, meta: {}, error: null });
        if (url.includes("/v1/invoices/inv_77"))
          return jsonResponse({ data: { id: "inv_77", invoiceNumber: "INV-2026-0077" }, meta: {}, error: null });
        return jsonResponse({ data: [], meta: { page: 1, limit: 50, total: 0, pageCount: 1 }, error: null });
      }),
    );
    const wrapper = mount(QuoteDetail, { global: { plugins: [vuetifyAt(1280), i18n] } });
    await flushPromises();
    await flushPromises();

    const alert = wrapper.find(".v-alert");
    expect(alert.text()).toContain("INV-2026-0077");
    expect(wrapper.text()).not.toContain("inv_77");
    wrapper.unmount();
  });

  it("convert: creates the invoice in one request and opens the new draft", async () => {
    const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string> });
        if (url.includes("/v1/quotes/q_1/convert") && method === "POST") {
          return jsonResponse({
            data: {
              quote: { ...quote, status: "converted", version: 4, convertedInvoiceId: "inv_9" },
              invoice: { id: "inv_9", invoiceNumber: null, status: "draft" },
            },
            meta: {},
            error: null,
          });
        }
        if (url.includes("/v1/quotes/q_1")) return jsonResponse({ data: { ...quote, status: "accepted" }, meta: {}, error: null });
        if (url.includes("/v1/invoices/inv_9")) return jsonResponse({ data: { id: "inv_9", invoiceNumber: null }, meta: {}, error: null });
        return jsonResponse({ data: [], meta: { page: 1, limit: 50, total: 0, pageCount: 1 }, error: null });
      }),
    );
    const wrapper = mount(QuoteDetail, { global: { plugins: [vuetifyAt(1280), i18n] } });
    await flushPromises();

    const convertBtn = wrapper.findAll("button").find((b) => b.text().includes(en.quotes.convert));
    expect(convertBtn).toBeTruthy();
    await convertBtn!.trigger("click");
    await flushPromises();
    await flushPromises();

    // Exactly ONE write — the convert route creates + links the invoice server-side.
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toContain("/v1/quotes/q_1/convert");
    expect(calls.some((c) => c.url.includes("/v1/invoices/from-quote"))).toBe(false);
    expect(routerPush).toHaveBeenCalledWith({ name: "invoice-detail", params: { id: "inv_9" } });
    // The converted alert links the (draft, unnumbered) invoice by label — never its raw id.
    const alert = wrapper.find(".v-alert");
    expect(alert.exists()).toBe(true);
    expect(alert.text()).not.toContain("inv_9");
    wrapper.unmount();
  });

  it("offers Convert for a legacy quote marked converted without an invoice (phone + desktop)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/v1/quotes/q_1"))
          return jsonResponse({ data: { ...quote, status: "converted", convertedInvoiceId: null }, meta: {}, error: null });
        return jsonResponse({ data: [], meta: { page: 1, limit: 50, total: 0, pageCount: 1 }, error: null });
      }),
    );
    for (const width of [390, 1280]) {
      const wrapper = mount(QuoteDetail, { global: { plugins: [vuetifyAt(width), i18n] } });
      await flushPromises();
      expect(wrapper.findAll("button").some((b) => b.text().includes(en.quotes.convert))).toBe(true);
      wrapper.unmount();
    }
  });
});
