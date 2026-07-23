import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createI18n } from "vue-i18n";
import { setActivePinia, createPinia } from "pinia";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import UserSettingsTab from "@/pages/settings/tabs/UserSettingsTab.vue";
import { useAuthStore } from "@/stores/auth";
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

const mountTab = () => mount(UserSettingsTab, { global: { plugins: [vuetify, i18n] } });

beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UserSettingsTab — TOTP enable flow", () => {
  it("runs setup → enable and shows the 10 backup codes once", async () => {
    const auth = useAuthStore();
    auth.principal = {
      userId: "u1",
      role: "member",
      capabilities: {
        canManageSettings: false,
        canManageUsers: false,
        canPermanentlyDelete: false,
        canViewFinancialTotals: false,
        canExportData: false,
      },
      accountId: "b",
      amrTwoFactor: false,
    };

    const codes = Array.from({ length: 10 }, (_, i) => `code-${i}`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: { otpauthUrl: "otpauth://totp/x", qrDataUrl: "data:image/png;base64,AAAA" },
          meta: {},
          error: null,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { enabled: true, backupCodes: codes }, meta: {}, error: null }));
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mountTab();
    const vm = wrapper.vm as unknown as {
      startEnable: () => Promise<void>;
      confirmEnable: () => Promise<void>;
      enableCode: string;
    };

    await vm.startEnable();
    await flushPromises();
    // The QR image is now rendered.
    expect(wrapper.find('img[src^="data:image/png"]').exists()).toBe(true);

    vm.enableCode = "123456";
    await vm.confirmEnable();
    await flushPromises();

    // The 10 backup codes are shown, exactly once.
    for (const c of codes) expect(wrapper.text()).toContain(c);
    expect(wrapper.text()).toContain(en.userSettings.totp.backupWarning);

    // The enable POST carried the entered code.
    const enableCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(enableCall[0]).toContain("/v1/auth/totp/enable");
    expect(JSON.parse(enableCall[1].body as string)).toEqual({ code: "123456" });
  });

  it("change-password rejects a mismatch before calling the API", async () => {
    const auth = useAuthStore();
    auth.principal = {
      userId: "u1",
      role: "member",
      capabilities: {
        canManageSettings: false,
        canManageUsers: false,
        canPermanentlyDelete: false,
        canViewFinancialTotals: false,
        canExportData: false,
      },
      accountId: "b",
    };
    const fetchMock = vi.fn(async () => jsonResponse({ data: { ok: true }, meta: {}, error: null }));
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mountTab();
    const vm = wrapper.vm as unknown as {
      newPassword: string;
      confirmPassword: string;
      changePassword: () => Promise<void>;
    };
    vm.newPassword = "longenough1";
    vm.confirmPassword = "different11";
    await vm.changePassword();
    await flushPromises();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain(en.userSettings.password.errors.mismatch);
  });
});
