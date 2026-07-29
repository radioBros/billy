import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import DocumentsTab from "@/pages/settings/tabs/DocumentsTab.vue";
import en from "@/locales/en.json";

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

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

const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

const GET_BODY = {
  defaultPaymentTermsDays: 30,
  defaultTaxRate: 0,
  invoiceNotes: null,
  quoteNotes: null,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settings form save — ApiError.details → field errors", () => {
  it("maps VALIDATION_FAILED details onto per-field :error-messages", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: GET_BODY, meta: {}, error: null }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            data: null,
            meta: {},
            error: {
              code: "VALIDATION_FAILED",
              message: "Invalid",
              details: { defaultPaymentTermsDays: "Must be between 1 and 8" },
            },
          },
          422,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(DocumentsTab, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();

    const vm = wrapper.vm as unknown as { save: () => Promise<void> };
    await vm.save();
    await flushPromises();

    // The field-level message is rendered by the bound v-text-field.
    expect(wrapper.text()).toContain("Must be between 1 and 8");
  });
});
