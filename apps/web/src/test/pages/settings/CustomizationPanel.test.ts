import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createI18n } from "vue-i18n";
import { setActivePinia, createPinia } from "pinia";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import CustomizationPanel from "@/pages/settings/CustomizationPanel.vue";
import { useAuthStore } from "@/stores/auth";
import type { Capabilities } from "@billy/types";
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
      addEventListener() {},
      removeEventListener() {},
      width: 1024,
      height: 768,
      offsetLeft: 0,
      offsetTop: 0,
      scale: 1,
    };
  }
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  canManageSettings: false,
  canManageUsers: false,
  canPermanentlyDelete: false,
  canViewFinancialTotals: false,
  canExportData: false,
  ...over,
});

const seedPrincipal = (capabilities: Capabilities): void => {
  const auth = useAuthStore();
  auth.principal = { userId: "u1", role: "member", capabilities, accountId: "b" };
};

const mountPanel = () => mount(CustomizationPanel, { global: { plugins: [vuetify, i18n] } });

beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
  // Child tabs may fetch on mount; return empty payloads.
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [], meta: {}, error: null })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const tabLabels = (wrapper: ReturnType<typeof mountPanel>): string[] =>
  wrapper.findAll(".v-tab").map((t) => t.text());

describe("CustomizationPanel — role-based tab visibility", () => {
  it("a non-admin sees ONLY the User Settings tab", async () => {
    seedPrincipal(caps());
    const wrapper = mountPanel();
    await flushPromises();
    const labels = tabLabels(wrapper);
    expect(labels).toEqual([en.settings.userSettingsTab]);
    expect(labels).not.toContain("Branding");
    expect(labels).not.toContain(en.settings.usersTab);
  });

  it("an admin with canManageSettings sees the customization tabs (not Users without canManageUsers)", async () => {
    seedPrincipal(caps({ canManageSettings: true }));
    const wrapper = mountPanel();
    await flushPromises();
    const labels = tabLabels(wrapper);
    expect(labels).toContain(en.settings.userSettingsTab);
    expect(labels).toContain("Branding");
    expect(labels).toContain("Company");
    expect(labels).not.toContain(en.settings.usersTab);
  });

  it("an admin with canManageUsers additionally sees the Users tab", async () => {
    seedPrincipal(caps({ canManageSettings: true, canManageUsers: true }));
    const wrapper = mountPanel();
    await flushPromises();
    const labels = tabLabels(wrapper);
    expect(labels).toContain(en.settings.userSettingsTab);
    expect(labels).toContain(en.settings.usersTab);
  });
});
