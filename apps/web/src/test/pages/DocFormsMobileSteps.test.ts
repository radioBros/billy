/**
 * Phone (< 600px) stepped layout of the document create forms (proforma, quote,
 * credit note). On phones each renders a 3-step FormSteps wizard holding every
 * desktop field, with Preview/Create in the wizard's sticky last-step bar; on
 * desktop the stacked cards keep their actions in the last card's footer.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import type { Component } from "vue";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import ProformaForm from "@/pages/proformas/ProformaForm.vue";
import QuoteForm from "@/pages/quotes/QuoteForm.vue";
import CreditNoteForm from "@/pages/credit-notes/CreditNoteForm.vue";
import RecurringToggle from "@/components/RecurringToggle.vue";
import en from "@/locales/en.json";
import { polyfillBrowser } from "@/test/helpers/einvoicing";

// jsdom has no real viewport: drive the breakpoint per test.
const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock("@/composables/useIsMobile", async () => {
  const { computed } = await import("vue");
  return { useIsMobile: () => computed(() => viewport.mobile) };
});
// The line editor has its own phone layout (line cards) and its own tests.
vi.mock("@/components/LineItemEditor.vue", () => ({
  default: { name: "LineItemEditor", template: "<div />" },
}));
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: {} }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

beforeAll(polyfillBrowser);
beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      const data = url.includes("/settings/business") ? { bankAccounts: [] } : url.includes("?") ? [] : {};
      return new Response(JSON.stringify({ data, meta: {}, error: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});
let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const render = async (form: Component, mobile: boolean): Promise<VueWrapper> => {
  viewport.mobile = mobile;
  wrapper = mount(form, { attachTo: document.body, global: { plugins: [vuetify, i18n] } });
  await flushPromises();
  return wrapper;
};

/** Labels of every input inside the form, in DOM order (sorted). */
const fieldLabels = (w: VueWrapper): string[] =>
  w.findAll("form .v-input .v-label:not(.v-field-label--floating)").map((l) => l.text()).sort();

const CASES: [string, Component, string][] = [
  ["ProformaForm", ProformaForm, en.proformas.create],
  ["QuoteForm", QuoteForm, en.quotes.create],
  ["CreditNoteForm", CreditNoteForm, en.creditNotes.create],
];

describe.each(CASES)("%s on phones", (_name, form, createLabel) => {
  it("renders a 3-step wizard holding every desktop field", async () => {
    const desktop = await render(form, false);
    expect(desktop.find(".form-steps").exists()).toBe(false);
    const desktopFields = fieldLabels(desktop);
    expect(desktopFields.length).toBeGreaterThan(3);
    // Desktop: Cancel / Preview / Create stay in the last card's footer.
    const footer = desktop.find(".v-card-actions");
    expect(footer.exists()).toBe(true);
    expect(footer.text()).toContain(en.common.cancel);
    expect(footer.find("button[type='submit']").text()).toContain(createLabel);
    desktop.unmount();
    wrapper = null;

    const phone = await render(form, true);
    expect(phone.findAll(".form-steps__segment")).toHaveLength(3);
    expect(phone.findAll(".form-steps__body")).toHaveLength(3);
    // Same inputs, only regrouped into steps (hidden steps stay mounted).
    expect(fieldLabels(phone)).toEqual(desktopFields);
    // Phone: no card footer — the actions belong to the wizard's sticky bar
    // (shown on the last step; step 1 offers Next).
    expect(phone.find(".form-steps__body .v-card-actions").exists()).toBe(false);
    expect(phone.find(".form-steps__body button[type='submit']").exists()).toBe(false);
    expect(phone.find(".form-steps__bar .form-steps__next").exists()).toBe(true);
  });
});

describe("RecurringToggle on phones", () => {
  it("renders settings-style switch rows only on phones", async () => {
    viewport.mobile = false;
    wrapper = mount(RecurringToggle, {
      props: { modelValue: null, docType: "proforma" },
      global: { plugins: [vuetify, i18n] },
    });
    await flushPromises();
    expect(wrapper.find(".recurring-toggle--mobile").exists()).toBe(false);
    expect(wrapper.find(".recurring-toggle__badge").exists()).toBe(false);
    wrapper.unmount();

    viewport.mobile = true;
    wrapper = mount(RecurringToggle, {
      props: { modelValue: null, docType: "proforma" },
      global: { plugins: [vuetify, i18n] },
    });
    await flushPromises();
    expect(wrapper.find(".recurring-toggle--mobile").exists()).toBe(true);
    expect(wrapper.find(".recurring-toggle__badge").exists()).toBe(true);
    expect(wrapper.text()).toContain(en.recurring.toggle.enable);
  });
});
