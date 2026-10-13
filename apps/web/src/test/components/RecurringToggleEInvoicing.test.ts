import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import RecurringToggle from "@/components/RecurringToggle.vue";
import { useRecurringProfile } from "@/composables/useRecurringProfile";
import * as apiClient from "@/api/client";
import en from "@/locales/en.json";
import { polyfillBrowser } from "@/test/helpers/einvoicing";
import type { RecurrenceConfig } from "@/types/domain";

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

beforeAll(polyfillBrowser);
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => vi.restoreAllMocks());

const mockSummary = (over: Record<string, unknown>) =>
  vi.spyOn(apiClient.api, "get").mockResolvedValue({ enabled: true, notSent: 0, overdue: 0, items: [], ...over } as never);

const mountToggle = async (docType: "invoice" | "proforma") => {
  const wrapper = mount(RecurringToggle, {
    props: { docType, modelValue: null },
    global: { plugins: [vuetify, i18n] },
  });
  await flushPromises();
  return wrapper;
};
const lastModel = (w: ReturnType<typeof mount>): RecurrenceConfig | null => {
  const ev = w.emitted("update:modelValue")!;
  return ev.at(-1)![0] as RecurrenceConfig | null;
};

describe("RecurringToggle — SdI switch", () => {
  it("shows for invoices, defaults to recurringDefaultSubmit and emits einvoice.autoSubmit", async () => {
    mockSummary({ recurringDefaultSubmit: true });
    const w = await mountToggle("invoice");
    await w.find('input[type="checkbox"]').setValue(true); // "Make this recurring"
    await flushPromises();
    const sw = w.find('[data-test="recurring-sdi-switch"] input');
    expect(sw.exists()).toBe(true);
    expect((sw.element as HTMLInputElement).checked).toBe(true);
    expect(lastModel(w)!.einvoice).toEqual({ autoSubmit: true });

    await sw.setValue(false);
    await flushPromises();
    expect(lastModel(w)!.einvoice).toEqual({ autoSubmit: false });
  });

  it("is absent when e-invoicing is off or for non-invoice documents", async () => {
    mockSummary({ enabled: false });
    const off = await mountToggle("invoice");
    await off.find('input[type="checkbox"]').setValue(true);
    await flushPromises();
    expect(off.find('[data-test="recurring-sdi-switch"]').exists()).toBe(false);
    expect(lastModel(off)!).not.toHaveProperty("einvoice");

    setActivePinia(createPinia());
    mockSummary({ enabled: true });
    const proforma = await mountToggle("proforma");
    await proforma.find('input[type="checkbox"]').setValue(true);
    await flushPromises();
    expect(proforma.find('[data-test="recurring-sdi-switch"]').exists()).toBe(false);
  });

  it("createProfile forwards the einvoice payload", async () => {
    const post = vi.spyOn(apiClient.api, "post").mockResolvedValue({} as never);
    let create!: ReturnType<typeof useRecurringProfile>["createProfile"];
    mount({
      template: "<div />",
      setup() {
        create = useRecurringProfile().createProfile;
        return {};
      },
    }, { global: { plugins: [i18n] } });
    await create({
      documentType: "invoice",
      clientId: "c1",
      currency: "EUR",
      lineItems: [],
      recurrence: { enabled: true, interval: "monthly", intervalCount: 1, startDate: "2026-11-01", einvoice: { autoSubmit: true } },
    });
    expect((post.mock.calls[0]![1] as Record<string, unknown>).einvoice).toEqual({ autoSubmit: true });
  });
});
