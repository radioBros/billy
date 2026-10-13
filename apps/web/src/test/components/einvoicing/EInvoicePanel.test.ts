import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import EInvoicePanel from "@/components/einvoicing/EInvoicePanel.vue";
import en from "@/locales/en.json";
import { ok, on, routeFetch, einvoiceInfo, polyfillBrowser } from "@/test/helpers/einvoicing";
import type { EInvoiceInfo } from "@/types/domain";

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

beforeAll(polyfillBrowser);
beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

const mountPanel = async (info: EInvoiceInfo, props: Record<string, unknown> = {}) => {
  const calls = routeFetch(on("GET", "/v1/invoices/inv1/einvoice", () => ok(info)));
  wrapper = mount(EInvoicePanel, {
    props: { kind: "invoices", documentId: "inv1", clientId: "c1", ...props },
    attachTo: document.body,
    global: { plugins: [vuetify, i18n] },
  });
  await flushPromises();
  return { wrapper: wrapper!, calls };
};

describe("EInvoicePanel", () => {
  it("is invisible when e-invoicing is off for the document", async () => {
    const { wrapper: w } = await mountPanel(einvoiceInfo({ enabled: false }));
    expect(w.find('[data-test="einvoice-panel"]').exists()).toBe(false);
  });

  it("not sent: shows the overdue deadline warning and only the Send action", async () => {
    const { wrapper: w } = await mountPanel(
      einvoiceInfo({ status: "not_sent", canSubmit: true, deadline: { dueBy: "2026-09-20", overdue: true, finalizedBeforeEnable: false } }),
    );
    expect(w.find('[data-test="einvoice-status-chip"]').text()).toBe("Not sent to SdI");
    expect(w.find('[data-test="einvoice-deadline"]').text()).toContain("2026-09-20");
    expect(w.find('[data-test="einvoice-action-submit"]').exists()).toBe(true);
    expect(w.find('[data-test="einvoice-action-retry"]').exists()).toBe(false);
    expect(w.find('[data-test="einvoice-action-xml"]').exists()).toBe(false);
  });

  it("rejected (NS): lists the SdI error with code, description and remedy, and says to re-issue", async () => {
    const { wrapper: w } = await mountPanel(
      einvoiceInfo({
        status: "rejected",
        canSubmit: false,
        guidance: "rejected_reissue",
        identificativoSdI: "123456",
        fileName: "IT01234567890_00001.xml",
        hasXml: true,
        attempts: [
          {
            attempt: 1,
            at: "2026-10-02T09:00:00Z",
            status: "rejected",
            receipts: [
              {
                type: "NS",
                receivedAt: "2026-10-02T09:05:00Z",
                errors: [{ code: "00400", description: "Natura mancante", remedy: "Indicare la Natura" }],
              },
            ],
          },
        ],
      }),
    );
    expect(w.find('[data-test="einvoice-guidance"]').text()).toContain("NOT issued");
    expect(w.find('[data-test="einvoice-sdi-id"]').text()).toBe("123456");
    const err = w.find('[data-test="einvoice-sdi-error"]').text();
    expect(err).toContain("00400");
    expect(err).toContain("Natura mancante");
    expect(err).toContain("Indicare la Natura");
    expect(w.find('[data-test="receipt-NS"]').text()).toContain("NS");
    // No resend of a rejected number; XML + AdE view are offered.
    expect(w.find('[data-test="einvoice-action-submit"]').exists()).toBe(false);
    expect(w.find('[data-test="einvoice-action-xml"]').attributes("href")).toBe("http://api.test/api/v1/invoices/inv1/einvoice/xml");
    expect(w.find('[data-test="einvoice-action-rendered"]').attributes("target")).toBe("_blank");
  });

  it("issued without delivery: 'do not resubmit' guidance, no Send / Retry", async () => {
    const { wrapper: w } = await mountPanel(
      einvoiceInfo({ status: "undelivered_attested", legallyIssued: true, canSubmit: false, guidance: "undelivered_tell_client" }),
    );
    expect(w.find('[data-test="einvoice-guidance"]').text()).toContain("Do NOT resubmit");
    expect(w.find('[data-test="einvoice-action-submit"]').exists()).toBe(false);
    expect(w.find('[data-test="einvoice-action-retry"]').exists()).toBe(false);
  });

  it("failed: Retry posts to /retry", async () => {
    const calls = routeFetch(
      on("POST", "/v1/invoices/inv1/einvoice/retry", () => ok({ status: "queued" }, 202)),
      on("GET", "/v1/invoices/inv1/einvoice", () => ok(einvoiceInfo({ status: "failed", canSubmit: false, canRetry: true, guidance: "failed_retry" }))),
    );
    wrapper = mount(EInvoicePanel, {
      props: { kind: "invoices", documentId: "inv1" },
      attachTo: document.body,
      global: { plugins: [vuetify, i18n] },
    });
    await flushPromises();
    await wrapper.find('[data-test="einvoice-action-retry"]').trigger("click");
    await flushPromises();
    expect(calls.some((c) => c.method === "POST" && c.path === "/v1/invoices/inv1/einvoice/retry")).toBe(true);
  });

  it("emits the legally-issued flag so the host can disable Void", async () => {
    const { wrapper: w } = await mountPanel(einvoiceInfo({ status: "delivered", legallyIssued: true, canSubmit: false }));
    const loaded = w.emitted("loaded")!;
    expect((loaded[0]![0] as EInvoiceInfo).legallyIssued).toBe(true);
  });

  it("scheduled invoice: the submit-on-issue switch PATCHes submitOnFinalize", async () => {
    const calls = routeFetch(
      on("PATCH", "/v1/invoices/inv1/einvoice", () => ok(einvoiceInfo({ submitOnFinalize: true }))),
      on("GET", "/v1/invoices/inv1/einvoice", () => ok(einvoiceInfo({ submitOnFinalize: false, canSubmit: false }))),
    );
    wrapper = mount(EInvoicePanel, {
      props: { kind: "invoices", documentId: "inv1", scheduled: true },
      attachTo: document.body,
      global: { plugins: [vuetify, i18n] },
    });
    await flushPromises();
    await wrapper.find('[data-test="einvoice-submit-on-finalize"] input').setValue(true);
    await flushPromises();
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ submitOnFinalize: true });
  });
});
