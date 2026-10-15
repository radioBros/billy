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

// Phone layout (< 600px): jsdom has no real viewport, so force the breakpoint.
vi.mock("@/composables/useIsMobile", () => ({ useIsMobile: () => computed(() => true) }));
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { id: "inv1" } }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/SendDocumentModal.vue", () => ({ default: { name: "SendDocumentModal", template: "<div />" } }));
vi.mock("@/components/DocumentActions.vue", () => ({ default: { name: "DocumentActions", template: "<div data-test='doc-actions' />" } }));

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

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

const INVOICE = {
  id: "inv1",
  version: 4,
  status: "partially_paid",
  clientId: "c1",
  invoiceNumber: "2026-0001",
  currency: "EUR",
  issueDate: "2026-10-01",
  dueDate: "2026-10-31",
  lineItems: [{ description: "Website build", quantity: 2, unitPriceMinor: 50000, taxRate: 22, lineTotalMinor: 122000 }],
  subtotalMinor: 100000,
  taxMinor: 22000,
  grandTotalMinor: 122000,
  amountPaidMinor: 20000,
  amountDueMinor: 102000,
  payments: [{ id: "p1", amountMinor: 20000, date: "2026-10-05", method: "bank_transfer", reference: "WIRE-1", createdAt: "" }],
};

const mountDetail = async (einvoice = einvoiceInfo({ status: "delivered", legallyIssued: true, canSubmit: false })) => {
  routeFetch(
    on("GET", "/v1/einvoicing/summary", () => ok({ enabled: true, notSent: 0, overdue: 0, items: [] })),
    on("GET", "/v1/invoices/inv1/einvoice", () => ok(einvoice)),
    on("GET", "/v1/invoices/inv1", () => ok(INVOICE)),
    on("GET", "/v1/settings/business", () => ok({ bankAccounts: [] })),
    on("GET", /\/v1\/clients/u, () => ok({ data: [] })),
  );
  wrapper = mount(InvoiceDetail, { attachTo: document.body, global: { plugins: [vuetify, i18n] } });
  await flushPromises();
  return wrapper!;
};

describe("InvoiceDetail — phone layout", () => {
  it("renders the hero summary, line cards and payment cards instead of tables", async () => {
    const w = await mountDetail();
    expect(w.find(".dd-hero__number").text()).toBe("2026-0001");
    expect(w.find(".dd-hero__total").text()).toContain("1,220.00");
    expect(w.findAll(".dd-line")).toHaveLength(1);
    expect(w.find(".dd-line__desc").text()).toBe("Website build");
    expect(w.findAll(".dd-pay")).toHaveLength(1);
    expect(w.find(".dd-pay__sub").text()).toContain("WIRE-1");
    expect(w.find("table").exists()).toBe(false);
    // Add payment leads while money is due; the document actions sit below it.
    expect(w.find(".dd-actions__primary").text()).toContain("Add payment");
    expect(w.find('[data-test="doc-actions"]').exists()).toBe(true);
    // The SdI panel stays mounted on phones (it feeds legallyIssued).
    expect(w.find('[data-test="einvoice-panel"]').exists()).toBe(true);
  });

  it("puts Void in the overflow menu and disables it once legally issued at SdI", async () => {
    const w = await mountDetail();
    await w.find('[data-test="invoice-more"]').trigger("click");
    await flushPromises();
    const voidItem = document.body.querySelector('[data-test="invoice-void"]');
    expect(voidItem).not.toBeNull();
    expect(voidItem!.classList.contains("v-list-item--disabled")).toBe(true);
    expect(voidItem!.textContent).toContain("credit note");
  });

  it("keeps Void enabled in the overflow menu when not legally issued", async () => {
    const w = await mountDetail(einvoiceInfo({ status: "not_sent", legallyIssued: false, canSubmit: true }));
    await w.find('[data-test="invoice-more"]').trigger("click");
    await flushPromises();
    const voidItem = document.body.querySelector('[data-test="invoice-void"]');
    expect(voidItem).not.toBeNull();
    expect(voidItem!.classList.contains("v-list-item--disabled")).toBe(false);
  });
});
