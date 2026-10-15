/**
 * Phone (< 600px) stepped layout of the create/edit forms. Each form must render
 * a FormSteps wizard on phones with EVERY field still mounted (all steps stay in
 * the v-form, so submit validation covers them) — and the desktop layout must keep
 * exactly the same set of inputs, without the wizard.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import type { Component } from "vue";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import ClientsForm from "@/pages/ClientsForm.vue";
import ContractForm from "@/pages/contracts/ContractForm.vue";
import ExpenseForm from "@/pages/expenses/ExpenseForm.vue";
import SubscriptionForm from "@/pages/subscriptions/SubscriptionForm.vue";
import TimeEntryForm from "@/pages/time-entries/TimeEntryForm.vue";
import ProjectForm from "@/pages/projects/ProjectForm.vue";
import en from "@/locales/en.json";
import { polyfillBrowser } from "@/test/helpers/einvoicing";

// jsdom has no real viewport: drive the breakpoint per test.
const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock("@/composables/useIsMobile", async () => {
  const { computed } = await import("vue");
  return { useIsMobile: () => computed(() => viewport.mobile) };
});
const routeParams: { params: Record<string, string> } = { params: {} };
vi.mock("vue-router", () => ({
  useRoute: () => routeParams,
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

const CLIENT = {
  id: "c1",
  version: 3,
  type: "company",
  displayName: "Acme",
  legalName: "Acme S.p.A.",
  tags: [],
};

beforeAll(polyfillBrowser);
beforeEach(() => {
  setActivePinia(createPinia());
  routeParams.params = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      const data = url.includes("/v1/clients/c1") ? CLIENT : url.includes("?") ? [] : {};
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

/** Labels of every input inside the form, in DOM order. */
const fieldLabels = (w: VueWrapper): string[] =>
  w.findAll("form .v-input .v-label:not(.v-field-label--floating)").map((l) => l.text()).sort();

const CASES: [string, Component, number][] = [
  ["ClientsForm", ClientsForm, 3],
  ["ContractForm", ContractForm, 3],
  ["ExpenseForm", ExpenseForm, 2],
  ["SubscriptionForm", SubscriptionForm, 2],
  ["TimeEntryForm", TimeEntryForm, 2],
];

describe.each(CASES)("%s on phones", (_name, form, steps) => {
  it(`renders a ${steps}-step wizard holding every desktop field`, async () => {
    const desktop = await render(form, false);
    expect(desktop.find(".form-steps").exists()).toBe(false);
    const desktopFields = fieldLabels(desktop);
    expect(desktopFields.length).toBeGreaterThan(3);
    desktop.unmount();
    wrapper = null;

    const phone = await render(form, true);
    expect(phone.find(".form-steps").exists()).toBe(true);
    expect(phone.findAll(".form-steps__segment")).toHaveLength(steps);
    expect(phone.findAll(".form-steps__body")).toHaveLength(steps);
    // Same inputs, only regrouped into steps (hidden steps stay mounted).
    expect(fieldLabels(phone)).toEqual(desktopFields);
    // The submit button lives in the wizard's last-step bar.
    expect(phone.find(".form-steps__next").exists()).toBe(true);
  });
});

describe("ClientsForm edit on phones", () => {
  it("moves the danger-zone actions into the header overflow menu", async () => {
    routeParams.params = { id: "c1" };
    const desktop = await render(ClientsForm, false);
    expect(desktop.text()).toContain(en.clients.dangerZone.title);
    expect(desktop.find("[data-test='client-actions-menu']").exists()).toBe(false);
    desktop.unmount();
    wrapper = null;

    const phone = await render(ClientsForm, true);
    expect(phone.text()).not.toContain(en.clients.dangerZone.title);
    const menu = phone.find("[data-test='client-actions-menu']");
    expect(menu.exists()).toBe(true);
    await menu.trigger("click");
    await flushPromises();
    const items = Array.from(document.body.querySelectorAll(".v-overlay .v-list-item")).map((el) => el.textContent?.trim());
    expect(items).toContain(en.clients.archive);
  });
});

describe("ProjectForm on phones", () => {
  it("stays a single card (no wizard) without the Cancel button", async () => {
    const phone = await render(ProjectForm, true);
    expect(phone.find(".form-steps").exists()).toBe(false);
    expect(phone.text()).not.toContain(en.common.cancel);
    expect(phone.find("button[type='submit']").exists()).toBe(true);
  });
});
