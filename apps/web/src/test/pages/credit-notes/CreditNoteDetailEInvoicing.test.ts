import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import CreditNoteDetail from "@/pages/credit-notes/CreditNoteDetail.vue";
import en from "@/locales/en.json";
import { ok, on, routeFetch, einvoiceInfo, polyfillBrowser } from "@/test/helpers/einvoicing";

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { id: "cn1" } }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/DocumentActions.vue", () => ({ default: { name: "DocumentActions", template: "<div />" } }));

beforeAll(polyfillBrowser);
beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});
let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const CN = { id: "cn1", version: 2, status: "issued", clientId: "c1", creditNoteNumber: "CN-1", currency: "EUR", lineItems: [] };
const BTN = '[data-test="einvoice-header-action"]';

const mountDetail = async (enabled: boolean, status = "issued", info = einvoiceInfo()) => {
  const calls = routeFetch(
    on("GET", "/v1/einvoicing/summary", () => ok({ enabled, notSent: 0, overdue: 0, items: [] })),
    on("GET", "/v1/credit-notes/cn1/einvoice", () => ok(info)),
    on("GET", "/v1/credit-notes/cn1", () => ok({ ...CN, status })),
    on("GET", /\/v1\/clients/u, () => ok({ data: [] })),
  );
  wrapper = mount(CreditNoteDetail, { attachTo: document.body, global: { plugins: [vuetify, i18n] } });
  await flushPromises();
  return { wrapper: wrapper!, calls };
};

const CHIP = '[data-test="einvoice-sent-chip"]';
const hidden = (w: VueWrapper) => (w.find('[data-test="einvoice-collapse"]').element as HTMLElement).style.display === "none";

describe("CreditNoteDetail — SdI header toggle", () => {
  it("off: no button", async () => {
    expect((await mountDetail(false)).wrapper.find(BTN).exists()).toBe(false);
  });
  it("draft: no button, no chip", async () => {
    const { wrapper: w } = await mountDetail(true, "draft");
    expect(w.find(BTN).exists()).toBe(false);
    expect(w.find(CHIP).exists()).toBe(false);
  });
  it("not sent: collapsed, expands on click, no chip", async () => {
    const { wrapper: w } = await mountDetail(true);
    expect(w.find(BTN).text()).toBe("SdI · Not sent");
    expect(hidden(w)).toBe(true);
    expect(w.find(CHIP).exists()).toBe(false);
    await w.find(BTN).trigger("click");
    expect(w.find(BTN).attributes("aria-expanded")).toBe("true");
    expect(hidden(w)).toBe(false);
    await w.find('[data-test="einvoice-action-submit"]').trigger("click");
    await flushPromises();
    expect(document.body.querySelector('[data-test="einvoice-submit-step"]')).not.toBeNull();
  });
  it("delivered: success label and chip while collapsed", async () => {
    const { wrapper: w } = await mountDetail(true, "issued", einvoiceInfo({ status: "delivered", canSubmit: false }));
    expect(w.find(BTN).text()).toBe("Sent to SdI · Delivered");
    expect(w.find(BTN).attributes("disabled")).toBeUndefined();
    expect(w.find(CHIP).text()).toBe("Sent to SdI · Delivered");
    expect(hidden(w)).toBe(true);
  });
  it("failed and rejected auto-open", async () => {
    const a = await mountDetail(true, "issued", einvoiceInfo({ status: "failed", canSubmit: false, canRetry: true }));
    expect(a.wrapper.find(BTN).text()).toBe("SdI · Failed");
    expect(hidden(a.wrapper)).toBe(false);
    a.wrapper.unmount();
    const b = await mountDetail(true, "issued", einvoiceInfo({ status: "rejected", canSubmit: true }));
    expect(b.wrapper.find(BTN).text()).toBe("SdI · Rejected");
    expect(hidden(b.wrapper)).toBe(false);
  });
});
