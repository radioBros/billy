import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import InvoiceForm from "@/pages/invoices/InvoiceForm.vue";
import en from "@/locales/en.json";

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

const push = vi.fn();
// create mode: no :id param.
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: {} }),
  useRouter: () => ({ back: vi.fn(), push }),
}));

// Stub the send modal everywhere in this file — its preview/submit behaviour has
// its own test, and its Vuetify combobox/RTE add teardown noise to page tests.
vi.mock("@/components/SendDocumentModal.vue", () => ({
  default: { name: "SendDocumentModal", template: "<div data-test='send-stub' />" },
}));
// The create-completion flow doesn't depend on these heavy children; stub them so
// their async data-loading (client search etc.) can't emit teardown races here.
vi.mock("@/components/ClientSelector.vue", () => ({
  default: { name: "ClientSelector", template: "<div />" },
}));
vi.mock("@/components/ProjectSelect.vue", () => ({
  default: { name: "ProjectSelect", template: "<div />" },
}));
vi.mock("@/components/LineItemEditor.vue", () => ({
  default: { name: "LineItemEditor", template: "<div />" },
}));
vi.mock("@/components/RecurringToggle.vue", () => ({
  default: { name: "RecurringToggle", template: "<div />" },
}));

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as unknown as { visualViewport?: unknown }).visualViewport ??= {
    width: 1024,
    height: 768,
    offsetLeft: 0,
    offsetTop: 0,
    scale: 1,
    addEventListener() {},
    removeEventListener() {},
  };
});

const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
  push.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("InvoiceForm create-completion flow", () => {
  it("after creating a draft it shows the next-step choice instead of navigating", async () => {
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        // Business settings (bank picker) load on mount.
        if (url.includes("/settings/business")) {
          return jsonResponse({ data: { bankAccounts: [] }, meta: {}, error: null });
        }
        if (init?.method === "POST" && url.endsWith("/v1/invoices")) {
          posts.push(url);
          return jsonResponse(
            { data: { id: "inv_new", version: 1, status: "draft" }, meta: {}, error: null },
            201,
          );
        }
        return jsonResponse({ data: {}, meta: {}, error: null });
      }),
    );

    const wrapper = mount(InvoiceForm, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();

    // Drive the create directly (bypasses field-level form validation UI).
    await (wrapper.vm as unknown as { save: () => Promise<void> }).save();
    await flushPromises();

    expect(posts.length).toBe(1);
    // The create-completion dialog is shown (teleported to <body>) with all three choices.
    const text = document.body.textContent ?? "";
    expect(text).toContain(en.invoices.completion.finalizeAndSend);
    expect(text).toContain(en.invoices.completion.schedule);
    expect(text).toContain(en.invoices.completion.keepDraft);
    // We did NOT navigate away yet — navigation is the dialog's job.
    expect(push).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("'Finalize & send' finalizes the draft then opens the send modal", async () => {
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        calls.push({ url, method: init?.method });
        if (url.includes("/settings/business")) {
          return jsonResponse({ data: { bankAccounts: [] }, meta: {}, error: null });
        }
        if (init?.method === "POST" && url.endsWith("/v1/invoices")) {
          return jsonResponse({ data: { id: "inv_new", version: 1, status: "draft" }, meta: {}, error: null }, 201);
        }
        if (url.includes("/finalize")) {
          return jsonResponse({ data: { id: "inv_new", version: 2, status: "finalized" }, meta: {}, error: null });
        }
        if (url.includes("/send/preview")) {
          return jsonResponse({ data: { to: "c@e.com", subject: "S", html: "<p>B</p>" }, meta: {}, error: null });
        }
        return jsonResponse({ data: {}, meta: {}, error: null });
      }),
    );

    const wrapper = mount(InvoiceForm, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();
    await (wrapper.vm as unknown as { save: () => Promise<void> }).save();
    await flushPromises();

    // Click "Finalize & send" in the teleported dialog.
    const btn = document.body.querySelector('[data-test="completion-finalize-send"]') as HTMLElement | null;
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();

    expect(calls.some((c) => c.url.includes("/v1/invoices/inv_new/finalize") && c.method === "POST")).toBe(true);
    // finalizeAndSend closes the choice dialog and opens the send modal → the
    // stubbed SendDocumentModal is rendered (its own test covers preview/submit).
    expect(wrapper.findComponent({ name: "SendDocumentModal" }).exists()).toBe(true);
    wrapper.unmount();
  });
});
