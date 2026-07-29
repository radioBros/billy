import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createI18n } from "vue-i18n";
import { setActivePinia, createPinia } from "pinia";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import UsersTab from "@/pages/settings/tabs/UsersTab.vue";
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
  // Vuetify overlays (v-dialog/v-menu) read visualViewport; jsdom lacks it.
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

const user = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "u1",
  email: "ada@x.test",
  displayName: "Ada Lovelace",
  role: "administrator",
  capabilities: {
    canManageSettings: true,
    canManageUsers: true,
    canPermanentlyDelete: true,
    canViewFinancialTotals: true,
    canExportData: true,
  },
  status: "active",
  mustChangePassword: false,
  totpEnabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const mountTab = () => mount(UsersTab, { global: { plugins: [vuetify, i18n] } });

beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UsersTab", () => {
  it("lists users from GET /v1/users", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [user()], meta: {}, error: null })));
    const wrapper = mountTab();
    await flushPromises();
    expect(wrapper.text()).toContain("Ada Lovelace");
    expect(wrapper.text()).toContain("ada@x.test");
  });

  it("creates a user via POST /v1/users and appends the row", async () => {
    const created = user({ id: "u2", email: "bob@x.test", displayName: "Bob", role: "member", totpEnabled: false });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [], meta: {}, error: null })) // initial list
      .mockResolvedValueOnce(jsonResponse({ data: created, meta: {}, error: null })); // create
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mountTab();
    await flushPromises();

    const vm = wrapper.vm as unknown as {
      openCreate: () => void;
      form: { email: string; displayName: string; password: string };
      save: () => Promise<void>;
    };
    vm.openCreate();
    vm.form.email = "bob@x.test";
    vm.form.displayName = "Bob";
    vm.form.password = "password1";
    await vm.save();
    await flushPromises();

    const createCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(createCall[0]).toContain("/v1/users");
    expect(createCall[1].method).toBe("POST");
    expect(wrapper.text()).toContain("Bob");
  });

  it("surfaces the last-admin FORBIDDEN error on save", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [user()], meta: {}, error: null }))
      .mockResolvedValueOnce(
        jsonResponse({ data: null, meta: {}, error: { code: "FORBIDDEN", message: "last admin" } }, 403),
      );
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mountTab();
    await flushPromises();

    const vm = wrapper.vm as unknown as {
      openEdit: (u: unknown) => void;
      save: () => Promise<void>;
      formError: string | null;
    };
    vm.openEdit(user());
    await vm.save();
    await flushPromises();

    // The error lives in the (teleported) dialog; assert on component state.
    expect(vm.formError).toBe(en.users.errors.lastAdmin);
  });

  it("surfaces the DUPLICATE_VALUE error on create", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [], meta: {}, error: null }))
      .mockResolvedValueOnce(
        jsonResponse({ data: null, meta: {}, error: { code: "DUPLICATE_VALUE", message: "dup" } }, 409),
      );
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mountTab();
    await flushPromises();

    const vm = wrapper.vm as unknown as {
      openCreate: () => void;
      form: { email: string; password: string };
      save: () => Promise<void>;
      formError: string | null;
    };
    vm.openCreate();
    vm.form.email = "dupe@x.test";
    vm.form.password = "password1";
    await vm.save();
    await flushPromises();

    expect(vm.formError).toBe(en.users.errors.duplicate);
  });
});
