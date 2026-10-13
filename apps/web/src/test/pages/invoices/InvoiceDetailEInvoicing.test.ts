import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import InvoiceDetail from "@/pages/invoices/InvoiceDetail.vue";
import en from "@/locales/en.json";
import { ok, fail, on, routeFetch, einvoiceInfo, polyfillBrowser } from "@/test/helpers/einvoicing";
import { resolveConfirm } from "@/composables/useConfirm";
import { toasts } from "@/composables/useToast";

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { id: "inv1" } }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/SendDocumentModal.vue", () => ({ default: { name: "SendDocumentModal", template: "<div />" } }));
vi.mock("@/components/DocumentActions.vue", () => ({ default: { name: "DocumentActions", template: "<div />" } }));

beforeAll(polyfillBrowser);
beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
  toasts.splice(0, toasts.length);
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
  status: "sent",
  clientId: "c1",
  invoiceNumber: "2026-0001",
  currency: "EUR",
  issueDate: "2026-10-01",
  dueDate: "2026-10-31",
  lineItems: [],
  payments: [],
};

const mountDetail = async (enabled: boolean, einvoice = einvoiceInfo({ status: "delivered", legallyIssued: true, canSubmit: false }), extra = []) => {
  const calls = routeFetch(
    ...extra,
    on("GET", "/v1/einvoicing/summary", () => ok({ enabled, notSent: 0, overdue: 0, items: [] })),
    on("GET", "/v1/invoices/inv1/einvoice", () => ok(einvoice)),
    on("GET", "/v1/invoices/inv1", () => ok(INVOICE)),
    on("GET", "/v1/settings/business", () => ok({ bankAccounts: [] })),
    on("GET", /\/v1\/clients/u, () => ok({ data: [] })),
  );
  wrapper = mount(InvoiceDetail, { attachTo: document.body, global: { plugins: [vuetify, i18n] } });
  await flushPromises();
  return { wrapper: wrapper!, calls };
};

describe("InvoiceDetail — SdI panel", () => {
  it("disabled: no panel, no e-invoice calls, Void stays available", async () => {
    const { wrapper: w, calls } = await mountDetail(false);
    expect(w.find('[data-test="einvoice-panel"]').exists()).toBe(false);
    expect(calls.some((c) => c.path.endsWith("/einvoice"))).toBe(false);
    expect(w.find('[data-test="invoice-void"]').attributes("disabled")).toBeUndefined();
  });

  it("legally issued: shows the panel and disables Void with an explanation", async () => {
    const { wrapper: w } = await mountDetail(true);
    expect(w.find('[data-test="einvoice-panel"]').exists()).toBe(true);
    const voidBtn = w.find('[data-test="invoice-void"]');
    expect(voidBtn.attributes("disabled")).toBeDefined();
    expect(voidBtn.attributes("title")).toContain("credit note");
  });

  it("a 409 EINVOICE_LEGALLY_ISSUED on Void raises a clear toast and locks Void", async () => {
    const { wrapper: w } = await mountDetail(
      true,
      einvoiceInfo({ status: "queued", legallyIssued: false, canSubmit: false, inFlight: false }),
      [on("POST", "/v1/invoices/inv1/void", () => fail("EINVOICE_LEGALLY_ISSUED", 409))] as never,
    );
    expect(w.find('[data-test="invoice-void"]').attributes("disabled")).toBeUndefined();
    await w.find('[data-test="invoice-void"]').trigger("click");
    await flushPromises();
    resolveConfirm(true);
    await flushPromises();
    expect(toasts.some((t) => t.tone === "error" && t.text.includes("credit note"))).toBe(true);
    expect(w.find('[data-test="invoice-void"]').attributes("disabled")).toBeDefined();
  });
});

describe("InvoiceDetail — SdI header toggle", () => {
  const btn = (w: VueWrapper) => w.find('[data-test="einvoice-header-action"]');
  const chip = (w: VueWrapper) => w.find('[data-test="einvoice-sent-chip"]');
  const collapse = (w: VueWrapper) => w.find('[data-test="einvoice-collapse"]');
  const hidden = (w: VueWrapper) => (collapse(w).element as HTMLElement).style.display === "none";

  it("e-invoicing off: no button, no chip", async () => {
    const { wrapper: w } = await mountDetail(false);
    expect(btn(w).exists()).toBe(false);
    expect(chip(w).exists()).toBe(false);
  });

  it("draft invoice: no button, no chip, no e-invoice call", async () => {
    const calls = routeFetch(
      on("GET", "/v1/einvoicing/summary", () => ok({ enabled: true, notSent: 0, overdue: 0, items: [] })),
      on("GET", "/v1/invoices/inv1", () => ok({ ...INVOICE, status: "draft" })),
      on("GET", "/v1/settings/business", () => ok({ bankAccounts: [] })),
      on("GET", /\/v1\/clients/u, () => ok({ data: [] })),
    );
    wrapper = mount(InvoiceDetail, { attachTo: document.body, global: { plugins: [vuetify, i18n] } });
    await flushPromises();
    expect(btn(wrapper).exists()).toBe(false);
    expect(chip(wrapper).exists()).toBe(false);
    expect(calls.some((c) => c.path.endsWith("/einvoice"))).toBe(false);
  });

  it("not sent: collapsed, calm 'SdI · Not sent' next to Add payment, never disabled, no chip; click expands; Send is inside", async () => {
    const { wrapper: w } = await mountDetail(true, einvoiceInfo({ status: "not_sent", canSubmit: true }));
    const b = btn(w);
    expect(b.text()).toBe("SdI · Not sent");
    expect(b.attributes("disabled")).toBeUndefined();
    expect(b.attributes("aria-expanded")).toBe("false");
    expect((b.element.previousElementSibling as HTMLElement).textContent).toContain("Add payment");
    expect(chip(w).exists()).toBe(false);
    expect(hidden(w)).toBe(true);
    await b.trigger("click");
    await flushPromises();
    expect(btn(w).attributes("aria-expanded")).toBe("true");
    expect(hidden(w)).toBe(false);
    await w.find('[data-test="einvoice-action-submit"]').trigger("click");
    await flushPromises();
    expect(document.body.querySelector('[data-test="einvoice-submit-step"]')).not.toBeNull();
  });

  it.each([
    ["delivered", "Sent to SdI · Delivered"],
    ["awaiting_delivery", "Sent to SdI · Awaiting delivery"],
  ] as const)("%s: collapsed, success label, chip visible while collapsed", async (status, text) => {
    const { wrapper: w } = await mountDetail(
      true,
      einvoiceInfo({ status, canSubmit: false, submittedAt: "2026-10-01T10:00:00Z" }),
    );
    expect(btn(w).text()).toBe(text);
    expect(btn(w).attributes("disabled")).toBeUndefined();
    expect(hidden(w)).toBe(true);
    expect(chip(w).text()).toBe(text);
    expect(chip(w).attributes("data-kind")).toBe("sent");
  });

  it("queued: 'SdI · Sending…' on the button, 'Sent to SdI' chip", async () => {
    const { wrapper: w } = await mountDetail(true, einvoiceInfo({ status: "queued", canSubmit: false }));
    expect(btn(w).text()).toBe("SdI · Sending…");
    expect(chip(w).text()).toContain("Sent to SdI");
  });

  it("failed: auto-opens, 'SdI · Failed', Retry inside the panel", async () => {
    const { wrapper: w, calls } = await mountDetail(true, einvoiceInfo({ status: "failed", canSubmit: false, canRetry: true }));
    expect(btn(w).text()).toBe("SdI · Failed");
    expect(btn(w).attributes("aria-expanded")).toBe("true");
    expect(hidden(w)).toBe(false);
    await w.find('[data-test="einvoice-action-retry"]').trigger("click");
    await flushPromises();
    expect(calls.some((c) => c.method === "POST" && c.path === "/v1/invoices/inv1/einvoice/retry")).toBe(true);
  });

  it("rejected: auto-opens, 'SdI · Rejected', error chip 'Rejected by SdI'", async () => {
    const { wrapper: w } = await mountDetail(true, einvoiceInfo({ status: "rejected", canSubmit: true }));
    expect(btn(w).text()).toBe("SdI · Rejected");
    expect(hidden(w)).toBe(false);
    expect(chip(w).text()).toBe("Rejected by SdI");
  });

  it("clicking the header chip toggles the panel", async () => {
    const { wrapper: w } = await mountDetail(true, einvoiceInfo({ status: "delivered", canSubmit: false }));
    await chip(w).trigger("click");
    expect(hidden(w)).toBe(false);
  });
});
