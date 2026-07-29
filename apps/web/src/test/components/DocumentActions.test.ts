import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import DocumentActions from "@/components/DocumentActions.vue";
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
  // jsdom lacks visualViewport, which Vuetify's overlay location strategy reads.
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

beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const mountActions = (type = "invoice", id = "inv_1") => {
  return mount(DocumentActions, {
    props: { documentType: type as "invoice", documentId: id },
    global: { plugins: [vuetify, i18n] },
  });
};

describe("DocumentActions", () => {
  it("fetches the preview endpoint for the correct typePath and opens the dialog", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      calls.push(url);
      return jsonResponse({ data: { html: "<h1>Hi</h1>" }, meta: {}, error: null });
    }));

    const wrapper = mountActions("credit-note", "cn_9");
    await wrapper.findAll("button")[0]!.trigger("click"); // Preview
    await flushPromises();

    expect(calls.some((u) => u.includes("/v1/credit-notes/cn_9/preview"))).toBe(true);
    // v-dialog content is teleported to <body>, so query the document, not the wrapper.
    const iframe = document.body.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute("srcdoc")).toContain("<h1>Hi</h1>");
    wrapper.unmount();
  });

  it("downloads a ready PDF by anchor-clicking the downloadUrl", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.includes("/pdf")) {
        return jsonResponse({ data: { status: "ready", fileId: "f1", downloadUrl: "https://dl/f1.pdf" }, meta: {}, error: null });
      }
      return jsonResponse({ data: {}, meta: {}, error: null });
    }));

    const clicked: string[] = [];
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreate(tag) as HTMLElement;
      if (tag === "a") {
        (el as HTMLAnchorElement).click = () => clicked.push((el as HTMLAnchorElement).href);
      }
      return el;
    });

    const wrapper = mountActions();
    // Buttons: [0]=Preview, [1]=Print, [2]=Download.
    await wrapper.findAll("button")[2]!.trigger("click");
    await flushPromises();

    expect(clicked.some((h) => h.includes("dl/f1.pdf"))).toBe(true);
  });

  it("polls a pending PDF until ready, then downloads", async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.includes("/pdf")) {
        n += 1;
        if (n < 3) return jsonResponse({ data: { status: "pending", jobId: "j1" }, meta: {}, error: null });
        return jsonResponse({ data: { status: "ready", fileId: "f1", downloadUrl: "https://dl/ready.pdf" }, meta: {}, error: null });
      }
      return jsonResponse({ data: {}, meta: {}, error: null });
    }));

    const clicked: string[] = [];
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreate(tag) as HTMLElement;
      if (tag === "a") (el as HTMLAnchorElement).click = () => clicked.push((el as HTMLAnchorElement).href);
      return el;
    });

    const wrapper = mountActions();
    await wrapper.findAll("button")[2]!.trigger("click");
    // Two pending polls (1s each) then ready.
    await vi.advanceTimersByTimeAsync(2500);
    await flushPromises();

    expect(n).toBeGreaterThanOrEqual(3);
    expect(clicked.some((h) => h.includes("ready.pdf"))).toBe(true);
  });
});
