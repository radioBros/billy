import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { mount } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import EInvoiceActionButton from "@/components/einvoicing/EInvoiceActionButton.vue";
import en from "@/locales/en.json";
import { einvoiceInfo, polyfillBrowser } from "@/test/helpers/einvoicing";
import type { EInvoiceInfo } from "@/types/domain";

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });
beforeAll(polyfillBrowser);
afterEach(() => {
  document.body.innerHTML = "";
});

const m = (info: EInvoiceInfo | null, open = false) =>
  mount(EInvoiceActionButton, { props: { info, open }, attachTo: document.body, global: { plugins: [vuetify, i18n] } });
const BTN = '[data-test="einvoice-header-action"]';

describe("EInvoiceActionButton", () => {
  it("renders nothing without info or when e-invoicing is off", () => {
    expect(m(null).find(BTN).exists()).toBe(false);
    expect(m(einvoiceInfo({ enabled: false })).find(BTN).exists()).toBe(false);
  });

  it("toggles on click, reflects aria-expanded, never disabled", async () => {
    const w = m(einvoiceInfo({ status: "delivered", canSubmit: false }));
    expect(w.find(BTN).attributes("aria-expanded")).toBe("false");
    expect(w.find(BTN).attributes("disabled")).toBeUndefined();
    await w.find(BTN).trigger("click");
    expect(w.emitted("toggle")).toHaveLength(1);
    await w.setProps({ open: true });
    expect(w.find(BTN).attributes("aria-expanded")).toBe("true");
    expect(w.find(".einvoice-chevron--open").exists()).toBe(true);
  });

  it.each([
    ["not_sent", "SdI · Not sent"],
    ["blocked", "SdI · Not sent"],
    ["queued", "SdI · Sending…"],
    ["transmitted", "SdI · Sending…"],
    ["awaiting_delivery", "Sent to SdI · Awaiting delivery"],
    ["delivered", "Sent to SdI · Delivered"],
    ["undelivered_attested", "Sent to SdI · Issued (not delivered)"],
    ["accepted_by_pa", "Sent to SdI · Accepted by PA"],
    ["rejected_by_pa", "Sent to SdI · Rejected by PA"],
    ["rejected", "SdI · Rejected"],
    ["failed", "SdI · Failed"],
  ] as const)("%s label", (status, text) => {
    expect(m(einvoiceInfo({ status })).find(BTN).text()).toBe(text);
  });

  it("shows a warning dot only when the send deadline is overdue", () => {
    const due = { dueBy: "2026-09-01", overdue: true, finalizedBeforeEnable: false };
    expect(m(einvoiceInfo({ deadline: due })).find('[data-test="einvoice-overdue-dot"]').exists()).toBe(true);
    expect(m(einvoiceInfo({ deadline: { ...due, overdue: false } })).find('[data-test="einvoice-overdue-dot"]').exists()).toBe(false);
  });
});
