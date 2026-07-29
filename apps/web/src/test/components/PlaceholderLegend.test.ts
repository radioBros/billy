import { describe, it, expect, beforeAll } from "vitest";
import { mount } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import { createI18n } from "vue-i18n";
import en from "@/locales/en.json";
import PlaceholderLegend from "@/components/PlaceholderLegend.vue";

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
  // Vuetify's overlay location strategy reads window.visualViewport, absent in jsdom.
  if (!("visualViewport" in window) || window.visualViewport == null) {
    (window as unknown as { visualViewport: unknown }).visualViewport = {
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

const mountLegend = (docType: "invoice" | "quote") =>
  mount(PlaceholderLegend, {
    props: { docType },
    global: { plugins: [vuetify, i18n] },
    // v-menu teleports its panel; attaching to document.body lets us query it.
    attachTo: document.body,
  });

const openPanel = async (docType: "invoice" | "quote"): Promise<string> => {
  const wrapper = mountLegend(docType);
  // Drive the exposed `open` ref rather than relying on Vuetify's activator-click
  // timing in jsdom; the panel then teleports its content to <body>.
  (wrapper.vm as unknown as { open: boolean }).open = true;
  await wrapper.vm.$nextTick();
  await new Promise((r) => setTimeout(r, 0));
  await wrapper.vm.$nextTick();
  const text = document.body.textContent ?? "";
  wrapper.unmount();
  return text;
};

describe("PlaceholderLegend", () => {
  it("groups the tokens and includes dueDate but NOT expiryDate for invoices", async () => {
    const text = await openPanel("invoice");
    // Grouped headers present.
    expect(text).toContain(en.placeholders.groups.date);
    expect(text).toContain(en.placeholders.groups.client);
    expect(text).toContain(en.placeholders.groups.company);
    // Invoice-only date token is shown, quote-only is hidden.
    expect(text).toContain("{{dueDate}}");
    expect(text).not.toContain("{{expiryDate}}");
    // A shared token renders too.
    expect(text).toContain("{{client.name}}");
    // The dateHelp explainer renders the literal date examples injected as t() params
    // (proves the named-slot / param-injection path renders verbatim, not compiled).
    expect(text).toContain("{{date}}");
    expect(text).toContain('{{date -1|"MMMM"}}');
  });

  it("includes expiryDate but NOT dueDate for quotes", async () => {
    const text = await openPanel("quote");
    expect(text).toContain("{{expiryDate}}");
    expect(text).not.toContain("{{dueDate}}");
  });
});
