import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import ContractDetail from "@/pages/contracts/ContractDetail.vue";
import DocumentActions from "@/components/DocumentActions.vue";
import en from "@/locales/en.json";

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

// vue-router is not installed in this unit mount; stub the composables the page uses.
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { id: "ct_1" } }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));

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

const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ContractDetail", () => {
  it("loads the contract and exposes DocumentActions (Preview/Print/Download) + Send", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: {
            id: "ct_1",
            version: 2,
            title: "Support agreement",
            type: "support",
            status: "active",
            clientId: "cl_1",
            startDate: "2026-01-01",
            endDate: null,
            valueMinor: 500000,
            currency: "EUR",
            createdAt: "2026-01-01",
            updatedAt: "2026-01-01",
          },
          meta: {},
          error: null,
        }),
      ),
    );

    const wrapper = mount(ContractDetail, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();

    // DocumentActions is rendered → contracts now have Preview/Print/Download.
    expect(wrapper.findComponent(DocumentActions).exists()).toBe(true);
    // The Send button is present.
    const buttons = wrapper.findAll("button").map((b) => b.text());
    expect(buttons.some((label) => label.includes(en.contracts.send))).toBe(true);
    wrapper.unmount();
  });
});
