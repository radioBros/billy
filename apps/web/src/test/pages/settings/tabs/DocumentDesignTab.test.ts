import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import DocumentDesignTab from "@/pages/settings/tabs/DocumentDesignTab.vue";
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
});

const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

const BRANDING_BODY = {
  appName: "Acme",
  logoFileId: null,
  faviconFileId: null,
  primaryColor: "#5b5bd6",
  secondaryColor: "#6b7280",
  accentColor: "#8b8bf0",
  defaultThemeMode: "system",
  loginBackground: null,
  supportEmail: "hi@acme.test",
  documentHeaderHtml: "<b>Header</b><script>alert(1)</script>",
  documentFooterHtml: "<p>Thank you</p>",
};

const DOCUMENTS_BODY = {
  numberPrefix: "INV-",
  numberPadding: 4,
  defaultPaymentTerms: 30,
  defaultTaxRate: 0,
  defaultNotes: null,
  logoPosition: "left",
  showBankDetails: true,
  companyLogoFileId: null,
};

const BUSINESS_BODY = {
  businessName: "Your Company Ltd",
  legalName: "Your Company Legal Srl",
  vatNumber: "IT01234567890",
  taxCode: "CF-9",
  address: {
    line1: "1 Example Street",
    city: "Rome",
    region: "RM",
    postalCode: "00100",
    country: "IT",
  },
  email: "hi@company.test",
  phone: "+39 06 123456",
  website: "https://company.test",
  bankAccounts: [{ id: "b1", label: "Main account", details: "IT60X0542811101000000123456" }],
};

const routedFetch = (overrides: Partial<{ documents: unknown }> = {}) => {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/v1/settings/branding")) {
      return jsonResponse({ data: BRANDING_BODY, meta: {}, error: null });
    }
    if (url.includes("/v1/settings/documents")) {
      return jsonResponse({ data: overrides.documents ?? DOCUMENTS_BODY, meta: {}, error: null });
    }
    if (url.includes("/v1/settings/business")) {
      return jsonResponse({ data: BUSINESS_BODY, meta: {}, error: null });
    }
    return jsonResponse({ data: {}, meta: {}, error: null });
  });
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DocumentDesignTab", () => {
  it("renders the WYSIWYG editors for header and footer with a toolbar", async () => {
    vi.stubGlobal("fetch", routedFetch());
    const wrapper = mount(DocumentDesignTab, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();

    // Two RichTextEditor instances (header + footer), each a live TipTap editor.
    expect(wrapper.findAllComponents({ name: "RichTextEditor" }).length).toBe(2);
    expect(wrapper.findAll(".ProseMirror").length).toBe(2);
    // Print-safe toolbar buttons are present.
    expect(wrapper.find('[data-rte-btn="bold"]').exists()).toBe(true);
    expect(wrapper.find('[data-rte-btn="link"]').exists()).toBe(true);
    expect(wrapper.find('[data-rte-btn="alignRight"]').exists()).toBe(true);
  });

  it("renders the persisted controls and the full-width preview", async () => {
    vi.stubGlobal("fetch", routedFetch());
    const wrapper = mount(DocumentDesignTab, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();

    // Preview painted, driven by real business data.
    expect(wrapper.find(".doc-preview").exists()).toBe(true);
    expect(wrapper.text()).toContain("Your Company Ltd");
    // Grand total gets its own (large) element.
    expect(wrapper.find(".doc-preview__grand-total").exists()).toBe(true);
    // logoPosition toggle (left/right only) + persisted bank switch.
    const toggle = wrapper.findComponent({ name: "VBtnToggle" });
    expect(toggle.exists()).toBe(true);
    expect(wrapper.findComponent({ name: "VSwitch" }).exists()).toBe(true);
    // The company-logo upload moved to the Company tab — no file input here now.
    expect(wrapper.findComponent({ name: "VFileInput" }).exists()).toBe(false);
  });

  it("sanitizes admin header HTML in the preview (script stripped)", async () => {
    vi.stubGlobal("fetch", routedFetch());
    const wrapper = mount(DocumentDesignTab, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();

    const html = wrapper.find(".doc-preview").html();
    expect(html).toContain("<b>Header</b>");
    expect(html).not.toContain("<script>");
  });

  it("preview reacts to logoPosition — right inverts the header columns", async () => {
    vi.stubGlobal("fetch", routedFetch());
    const wrapper = mount(DocumentDesignTab, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();

    // Loaded with logoPosition=left → no reversed header.
    expect(wrapper.find(".doc-preview__header--rev").exists()).toBe(false);

    // Flip to right via the toggle → header columns reverse in the preview.
    const toggle = wrapper.findComponent({ name: "VBtnToggle" });
    toggle.vm.$emit("update:modelValue", "right");
    await flushPromises();
    expect(wrapper.find(".doc-preview__header--rev").exists()).toBe(true);
  });

  it("loads a persisted logoPosition=right and shows inverted columns", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({ documents: { ...DOCUMENTS_BODY, logoPosition: "right" } }),
    );
    const wrapper = mount(DocumentDesignTab, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();

    expect(wrapper.find(".doc-preview__header--rev").exists()).toBe(true);
  });
});
