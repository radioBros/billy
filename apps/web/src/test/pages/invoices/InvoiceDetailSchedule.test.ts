import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { computed } from "vue";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import InvoiceDetail from "@/pages/invoices/InvoiceDetail.vue";
import en from "@/locales/en.json";
import { ok, on, routeFetch, einvoiceInfo, polyfillBrowser } from "@/test/helpers/einvoicing";
import { translateValidationCode } from "@/utils/validationMessages";
import { i18n as appI18n } from "@/plugins/i18n";

// Scheduling only FINALIZES the invoice (+ SdI when chosen) — it never emails the
// client. The banner must say which of the two happens. Wording lives in the
// locale files, so these tests stub the two banner messages and assert on which
// one is rendered, not on the copy.
const isMobile = { value: false };
vi.mock("@/composables/useIsMobile", () => ({ useIsMobile: () => computed(() => isMobile.value) }));
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { id: "inv1" } }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/SendDocumentModal.vue", () => ({ default: { name: "SendDocumentModal", template: "<div />" } }));
vi.mock("@/components/DocumentActions.vue", () => ({ default: { name: "DocumentActions", template: "<div />" } }));

const messages = JSON.parse(JSON.stringify(en)) as typeof en & {
  invoices: { schedule: Record<string, string> };
};
messages.invoices.schedule.banner = "BANNER_FINALIZE {date}";
messages.invoices.schedule.bannerSdi = "BANNER_FINALIZE_SDI {date}";

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en: messages } });

beforeAll(polyfillBrowser);
beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
  isMobile.value = false;
});
let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const SCHEDULED = {
  id: "inv1",
  version: 3,
  status: "scheduled",
  clientId: "c1",
  invoiceNumber: null,
  currency: "EUR",
  issueDate: "2026-10-01",
  dueDate: "2026-10-08",
  scheduledSendDate: "2026-11-02",
  lineItems: [],
  payments: [],
};

const mountScheduled = async (enabled: boolean, submitOnFinalize: boolean) => {
  routeFetch(
    on("GET", "/v1/einvoicing/summary", () => ok({ enabled, notSent: 0, overdue: 0, items: [] })),
    on("GET", "/v1/invoices/inv1/einvoice", () => ok(einvoiceInfo({ submitOnFinalize }))),
    on("GET", "/v1/invoices/inv1", () => ok(SCHEDULED)),
    on("GET", "/v1/settings/business", () => ok({ bankAccounts: [] })),
    on("GET", /\/v1\/clients/u, () => ok({ data: [] })),
  );
  wrapper = mount(InvoiceDetail, { attachTo: document.body, global: { plugins: [vuetify, i18n] } });
  await flushPromises();
  await flushPromises();
  return wrapper!;
};

describe("InvoiceDetail — scheduled banner (finalize, not email)", () => {
  it("says the invoice will be finalized on the date when no SdI submission is chosen", async () => {
    const w = await mountScheduled(false, false);
    const banner = w.find('[data-test="schedule-banner"]');
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain("BANNER_FINALIZE 2026-11-02");
    expect(banner.text()).not.toContain("BANNER_FINALIZE_SDI");
  });

  it("mentions the SdI submission when the schedule will submit on finalize", async () => {
    const w = await mountScheduled(true, true);
    expect(w.find('[data-test="schedule-banner"]').text()).toContain("BANNER_FINALIZE_SDI 2026-11-02");
  });

  it("does not mention SdI when e-invoicing is on but submission was not chosen", async () => {
    const w = await mountScheduled(true, false);
    const text = w.find('[data-test="schedule-banner"]').text();
    expect(text).toContain("BANNER_FINALIZE 2026-11-02");
    expect(text).not.toContain("BANNER_FINALIZE_SDI");
  });

  it("renders the same banner on the phone layout", async () => {
    isMobile.value = true;
    const w = await mountScheduled(false, false);
    expect(w.find('[data-test="schedule-banner"]').text()).toContain("BANNER_FINALIZE 2026-11-02");
  });
});

describe("schedule past-date API error", () => {
  it("translates the API's date.not_past code (server-side schedule floor)", () => {
    const key = "validations.dates.notPast";
    expect(appI18n.global.te(key)).toBe(true);
    expect(translateValidationCode("date.not_past")).toBe(appI18n.global.t(key));
    expect(translateValidationCode("date.not_past")).not.toBe("date.not_past");
  });
});
