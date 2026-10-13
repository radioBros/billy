import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import EInvoiceSubmitStep from "@/components/einvoicing/EInvoiceSubmitStep.vue";
import en from "@/locales/en.json";
import { ok, fail, on, routeFetch, einvoiceInfo, polyfillBrowser } from "@/test/helpers/einvoicing";

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

beforeAll(polyfillBrowser);
beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const CLIENT = { id: "c1", displayName: "Rossi", recipientCode: "ABC1234", pecEmail: null };

let wrapper: VueWrapper | null = null;
const mountStep = async () => {
  wrapper = mount(EInvoiceSubmitStep, {
    props: { modelValue: true, kind: "invoices", documentId: "inv1", clientId: "c1" },
    attachTo: document.body,
    global: { plugins: [vuetify, i18n] },
  });
  await flushPromises();
  return wrapper;
};
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

// The dialog is teleported — always query within it.
const dlg = (): HTMLElement => document.body.querySelector('[data-test="einvoice-submit-step"]') as HTMLElement;
const q = (sel: string): HTMLElement | null => dlg()?.querySelector(sel) ?? null;
const click = async (sel: string): Promise<void> => {
  q(sel)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await flushPromises();
};

describe("EInvoiceSubmitStep", () => {
  it("ready: shows Ready, the recipient summary and the actions", async () => {
    routeFetch(
      on("POST", "/v1/invoices/inv1/einvoice/preflight", () => ok({ ok: true, issues: [], bolloMinor: 200 })),
      on("GET", "/v1/clients/c1", () => ok(CLIENT)),
    );
    await mountStep();
    expect(q('[data-test="einvoice-ready"]')).not.toBeNull();
    expect(q('[data-test="einvoice-recipient"]')!.textContent).toContain("ABC1234");
    expect(q('[data-test="einvoice-recipient"]')!.textContent).toContain("FPR12");
    expect(q('[data-test="einvoice-bollo"]')!.textContent).toContain("2.00");
    expect(q('[data-test="einvoice-send"]')).not.toBeNull();
    expect(q('[data-test="einvoice-skip"]')!.textContent).toContain("Not now");
    expect(q('[data-test="einvoice-blocked"]')).toBeNull();
  });

  it("blocked: lists the issues with Fix links opening in a new tab, no Send, and Re-check re-runs the preflight", async () => {
    let first = true;
    const calls = routeFetch(
      on("POST", "/v1/invoices/inv1/einvoice/preflight", () => {
        const res = first
          ? ok({
              ok: false,
              issues: [
                { code: "client.routing_missing", severity: "error", fix: "client" },
                { code: "business.province_missing", severity: "error", fix: "business" },
              ],
              bolloMinor: 0,
            })
          : ok({ ok: true, issues: [], bolloMinor: 0 });
        first = false;
        return res;
      }),
      on("GET", "/v1/clients/c1", () => ok(CLIENT)),
    );
    await mountStep();
    expect(q('[data-test="einvoice-blocked"]')).not.toBeNull();
    expect(q('[data-test="einvoice-send"]')).toBeNull();
    expect(q('[data-test="issue-client.routing_missing"]')!.textContent).toContain("SDI code or a PEC");
    const links = Array.from(dlg().querySelectorAll('[data-test="issue-fix"]')) as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/clients/c1/edit", "/settings/customization/company"]);
    expect(links.every((a) => a.getAttribute("target") === "_blank")).toBe(true);

    await click('[data-test="einvoice-recheck"]');
    expect(calls.filter((c) => c.path.endsWith("/preflight")).length).toBe(2);
    expect(q('[data-test="einvoice-ready"]')).not.toBeNull();
  });

  it("send: submits, shows the live status, and Continue reports submitted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let polls = 0;
    const calls = routeFetch(
      on("POST", "/v1/invoices/inv1/einvoice/preflight", () => ok({ ok: true, issues: [], bolloMinor: 0 })),
      on("POST", "/v1/invoices/inv1/einvoice/submit", () => ok({ status: "queued" }, 202)),
      on("GET", "/v1/invoices/inv1/einvoice", () => {
        polls += 1;
        return ok(einvoiceInfo(polls < 2 ? { status: "queued", inFlight: true } : { status: "transmitted", inFlight: false }));
      }),
      on("GET", "/v1/clients/c1", () => ok(CLIENT)),
    );
    const w = await mountStep();
    await click('[data-test="einvoice-send"]');
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/einvoice/submit"))).toBe(true);
    expect(q('[data-test="einvoice-sent"]')!.textContent).toContain("Queued");

    // Poll every 2 s until it leaves the in-flight state.
    await vi.advanceTimersByTimeAsync(2100);
    await vi.advanceTimersByTimeAsync(2100);
    await flushPromises();
    expect(q('[data-test="einvoice-sent"]')!.textContent).toContain("Transmitted");
    expect(polls).toBe(2);

    await click('[data-test="einvoice-continue"]');
    expect(w.emitted("done")![0]).toEqual([{ submitted: true, status: "transmitted" }]);
    expect(w.emitted("update:modelValue")![0]).toEqual([false]);
  });

  it("skip: 'Not now' closes and reports not submitted, without submitting", async () => {
    const calls = routeFetch(
      on("POST", "/v1/invoices/inv1/einvoice/preflight", () => ok({ ok: true, issues: [], bolloMinor: 0 })),
      on("GET", "/v1/clients/c1", () => ok(CLIENT)),
    );
    const w = await mountStep();
    await click('[data-test="einvoice-skip"]');
    expect(w.emitted("done")![0]).toEqual([{ submitted: false, status: null }]);
    expect(calls.some((c) => c.path.endsWith("/submit"))).toBe(false);
  });

  it("a 409 EINVOICE_NOT_READY on submit flips to the blocked list from the server issues", async () => {
    routeFetch(
      on("POST", "/v1/invoices/inv1/einvoice/preflight", () => ok({ ok: true, issues: [], bolloMinor: 0 })),
      on("POST", "/v1/invoices/inv1/einvoice/submit", () =>
        fail("EINVOICE_NOT_READY", 409, { issues: [{ code: "invoice.tax_rounding", severity: "error", fix: "invoice" }] }),
      ),
      on("GET", "/v1/clients/c1", () => ok(CLIENT)),
    );
    await mountStep();
    await click('[data-test="einvoice-send"]');
    expect(q('[data-test="einvoice-blocked"]')).not.toBeNull();
    expect(q('[data-test="issue-invoice.tax_rounding"]')).not.toBeNull();
  });
});
