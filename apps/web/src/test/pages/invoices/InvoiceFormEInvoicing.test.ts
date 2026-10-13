import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import InvoiceForm from "@/pages/invoices/InvoiceForm.vue";
import en from "@/locales/en.json";
import { ok, on, routeFetch, polyfillBrowser, type RecordedCall } from "@/test/helpers/einvoicing";

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

const push = vi.fn();
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: {} }),
  useRouter: () => ({ back: vi.fn(), push }),
}));
vi.mock("@/components/SendDocumentModal.vue", () => ({
  default: { name: "SendDocumentModal", template: "<div data-test='send-stub' />" },
}));
vi.mock("@/components/ClientSelector.vue", () => ({ default: { name: "ClientSelector", template: "<div />" } }));
vi.mock("@/components/ProjectSelect.vue", () => ({ default: { name: "ProjectSelect", template: "<div />" } }));
vi.mock("@/components/LineItemEditor.vue", () => ({ default: { name: "LineItemEditor", template: "<div />" } }));
vi.mock("@/components/RecurringToggle.vue", () => ({ default: { name: "RecurringToggle", template: "<div />" } }));

beforeAll(polyfillBrowser);
beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
  push.mockClear();
});
let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const SUMMARY_ON = { enabled: true, notSent: 0, overdue: 0, items: [], scheduledDefaultSubmit: true };

const routes = (summary: unknown) => [
  on("GET", "/v1/einvoicing/summary", () => ok(summary)),
  on("GET", "/v1/settings/business", () => ok({ bankAccounts: [] })),
  on("POST", "/v1/invoices", () => ok({ id: "inv_new", version: 1, status: "draft", clientId: "c1" }, 201)),
  on("POST", /\/finalize$/u, () => ok({ id: "inv_new", version: 2, status: "finalized", clientId: "c1" })),
  on("POST", /\/einvoice\/preflight$/u, () => ok({ ok: true, issues: [], bolloMinor: 0 })),
  on("POST", /\/schedule$/u, () => ok({ id: "inv_new", version: 3, status: "scheduled" })),
  on("GET", "/v1/clients/c1", () => ok({ id: "c1", recipientCode: "ABC1234" })),
];

const create = async (): Promise<VueWrapper> => {
  wrapper = mount(InvoiceForm, { attachTo: document.body, global: { plugins: [vuetify, i18n] } });
  await flushPromises();
  await (wrapper.vm as unknown as { save: () => Promise<void> }).save();
  await flushPromises();
  return wrapper;
};

const clickBody = async (sel: string): Promise<void> => {
  (document.body.querySelector(sel) as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await flushPromises();
};

const scheduleBody = (calls: RecordedCall[]): Record<string, unknown> | undefined =>
  calls.find((c) => c.method === "POST" && c.path.endsWith("/schedule"))?.body;

describe("InvoiceForm — SdI step after finalize", () => {
  it("enabled: finalize leads to the SdI step first, and 'Not now' continues to the email step", async () => {
    routeFetch(...routes(SUMMARY_ON));
    const w = await create();

    await clickBody('[data-test="completion-finalize-send"]');
    // The SdI step is up (preflight ran) and the email modal has NOT been opened yet.
    expect(document.body.querySelector('[data-test="einvoice-submit-step"]')).not.toBeNull();
    expect(document.body.querySelector('[data-test="einvoice-ready"]')).not.toBeNull();
    expect((w.vm as unknown as { sendModal: boolean }).sendModal).toBe(false);

    await clickBody('[data-test="einvoice-skip"]');
    expect((w.vm as unknown as { sendModal: boolean }).sendModal).toBe(true);
  });

  it("enabled but offerStepAfterFinalize=false: goes straight to the email step", async () => {
    routeFetch(...routes({ ...SUMMARY_ON, offerStepAfterFinalize: false }));
    const w = await create();
    await clickBody('[data-test="completion-finalize-send"]');
    expect(document.body.querySelector('[data-test="einvoice-submit-step"]')).toBeNull();
    expect((w.vm as unknown as { sendModal: boolean }).sendModal).toBe(true);
  });

  it("disabled: the SdI step never appears", async () => {
    const calls = routeFetch(...routes({ enabled: false, notSent: 0, overdue: 0, items: [] }));
    const w = await create();
    await clickBody('[data-test="completion-finalize-send"]');
    expect(document.body.querySelector('[data-test="einvoice-submit-step"]')).toBeNull();
    expect(calls.some((c) => c.path.includes("/einvoice/"))).toBe(false);
    expect((w.vm as unknown as { sendModal: boolean }).sendModal).toBe(true);
  });
});

describe("InvoiceForm — schedule dialog SdI checkbox", () => {
  it("defaults to scheduledDefaultSubmit and sends submitOnFinalize with the schedule call", async () => {
    const calls = routeFetch(...routes(SUMMARY_ON));
    const w = await create();
    await clickBody('[data-test="completion-schedule"]');

    const box = document.body.querySelector('[data-test="einvoice-schedule-checkbox"] input') as HTMLInputElement;
    expect(box).not.toBeNull();
    expect(box.checked).toBe(true);

    await (w.vm as unknown as { submitSchedule: () => Promise<void> }).submitSchedule();
    await flushPromises();
    expect(scheduleBody(calls)).toMatchObject({ submitOnFinalize: true });
  });

  it("can be unticked, and a client without routing triggers the inline warning", async () => {
    const calls = routeFetch(
      on("POST", /\/einvoice\/preflight$/u, () =>
        ok({ ok: false, issues: [{ code: "client.routing_missing", severity: "error", fix: "client" }, { code: "invoice.number_missing", severity: "error", fix: "invoice" }], bolloMinor: 0 }),
      ),
      ...routes(SUMMARY_ON),
    );
    const w = await create();
    await clickBody('[data-test="completion-schedule"]');
    expect(document.body.querySelector('[data-test="einvoice-schedule-warning"]')).not.toBeNull();
    // Only routing-type issues matter before the number exists.
    expect(document.body.querySelector('[data-test="issue-client.routing_missing"]')).not.toBeNull();
    expect(document.body.querySelector('[data-test="issue-invoice.number_missing"]')).toBeNull();

    await clickBody('[data-test="einvoice-schedule-checkbox"] input');
    expect(document.body.querySelector('[data-test="einvoice-schedule-warning"]')).toBeNull();
    await (w.vm as unknown as { submitSchedule: () => Promise<void> }).submitSchedule();
    await flushPromises();
    expect(scheduleBody(calls)).toMatchObject({ submitOnFinalize: false });
  });

  it("disabled: no checkbox and no submitOnFinalize key in the schedule call", async () => {
    const calls = routeFetch(...routes({ enabled: false, notSent: 0, overdue: 0, items: [] }));
    const w = await create();
    await clickBody('[data-test="completion-schedule"]');
    expect(document.body.querySelector('[data-test="einvoice-schedule-option"]')).toBeNull();
    await (w.vm as unknown as { submitSchedule: () => Promise<void> }).submitSchedule();
    await flushPromises();
    expect(scheduleBody(calls)).not.toHaveProperty("submitOnFinalize");
  });
});
