import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import SendDocumentModal from "@/components/SendDocumentModal.vue";
import en from "@/locales/en.json";

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    class RO {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  }
  if (!("visualViewport" in globalThis)) {
    (globalThis as unknown as { visualViewport: unknown }).visualViewport = {
      width: 1024,
      height: 768,
      offsetLeft: 0,
      offsetTop: 0,
      scale: 1,
      addEventListener() {},
      removeEventListener() {},
    };
  }
});

const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
};

const clickSubmit = (): void => {
  const btn = document.body.querySelector('[data-test="send-submit"]') as HTMLElement | null;
  btn?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // v-dialog teleports its content to <body>; wipe it so a prior test's leftover
  // submit button can't be matched by the next test's document.body query.
  document.body.innerHTML = "";
});

// TipTap needs getClientRects/range APIs jsdom lacks; RichTextEditor mounts fine
// but we stub the minimum so it initializes without throwing.
const mountModal = (props: Record<string, unknown> = {}) => {
  return mount(SendDocumentModal, {
    props: {
      modelValue: true,
      documentType: "invoice",
      documentId: "inv_1",
      version: 3,
      ...props,
    },
    global: { plugins: [vuetify, i18n] },
  });
};

describe("SendDocumentModal", () => {
  it("loads the preview endpoint (with kind) and pre-fills To + Subject", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        calls.push(url);
        return jsonResponse({
          data: { to: "client@example.com", subject: "Invoice 001", html: "<p>Hello</p>" },
          meta: {},
          error: null,
        });
      }),
    );

    mountModal({ kind: "invoice" });
    await flushPromises();

    expect(calls.some((u) => u.includes("/v1/invoices/inv_1/send/preview") && u.includes("kind=invoice"))).toBe(true);
    const to = document.body.querySelector('[data-test="send-to"] input') as HTMLInputElement | null;
    const subject = document.body.querySelector('[data-test="send-subject"] input') as HTMLInputElement | null;
    expect(to?.value).toBe("client@example.com");
    expect(subject?.value).toBe("Invoice 001");
  });

  it("uses the reminder path segment param when kind=reminder", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        calls.push(url);
        return jsonResponse({ data: { to: "c@e.com", subject: "Reminder", html: "<p>Hi</p>" }, meta: {}, error: null });
      }),
    );

    mountModal({ kind: "reminder", documentType: "contract", documentId: "ct_9" });
    await flushPromises();

    expect(calls.some((u) => u.includes("/v1/contracts/ct_9/send/preview") && u.includes("kind=reminder"))).toBe(true);
  });

  it("on { status: queued } emits sent + closes the modal", async () => {
    const methods: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        if (url.includes("/send/preview")) {
          return jsonResponse({ data: { to: "c@e.com", subject: "S", html: "<p>B</p>" }, meta: {}, error: null });
        }
        methods.push(init?.method);
        return jsonResponse({ data: { status: "queued", emailJobId: "j1", pdfPending: false }, meta: {}, error: null });
      }),
    );

    const wrapper = mountModal();
    await flushPromises();

    clickSubmit();
    await flushPromises();

    expect(methods).toContain("POST");
    expect(wrapper.emitted("sent")).toBeTruthy();
    const updates = wrapper.emitted("update:modelValue") ?? [];
    expect(updates.some((e) => e[0] === false)).toBe(true);
  });

  it("on { status: pending } keeps the modal open and does NOT emit sent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        if (url.includes("/send/preview")) {
          return jsonResponse({ data: { to: "c@e.com", subject: "S", html: "<p>B</p>" }, meta: {}, error: null });
        }
        return jsonResponse({ data: { status: "pending", pdfJobId: "p1", pdfPending: true }, meta: {}, error: null });
      }),
    );

    const wrapper = mountModal();
    await flushPromises();

    clickSubmit();
    await flushPromises();

    expect(wrapper.emitted("sent")).toBeFalsy();
    const updates = wrapper.emitted("update:modelValue") ?? [];
    expect(updates.some((e) => e[0] === false)).toBe(false);
  });

  it("on 503 QUEUE_UNAVAILABLE surfaces an error and stays open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        if (url.includes("/send/preview")) {
          return jsonResponse({ data: { to: "c@e.com", subject: "S", html: "<p>B</p>" }, meta: {}, error: null });
        }
        return jsonResponse({ data: null, error: { code: "QUEUE_UNAVAILABLE", message: "no queue" } }, 503);
      }),
    );

    const wrapper = mountModal();
    await flushPromises();

    clickSubmit();
    await flushPromises();

    expect(wrapper.emitted("sent")).toBeFalsy();
    expect(document.body.textContent).toContain("QUEUE_UNAVAILABLE");
  });
});
