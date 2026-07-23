import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createVuetify } from "vuetify";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import EmailTab from "@/pages/settings/tabs/EmailTab.vue";
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

const GET_BODY = {
  smtpHost: "smtp.acme.test",
  smtpPort: 587,
  smtpSecure: true,
  smtpUsername: "mailer",
  fromEmail: "no-reply@acme.test",
  fromName: "Acme",
  replyTo: null,
  smtpConfigured: true,
  // NOTE: no password field — the API never returns it.
};

const mountTab = () => {
  return mount(EmailTab, { global: { plugins: [createPinia(), vuetify, i18n] } });
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EmailTab — write-only password", () => {
  it("never binds a password from GET and shows the configured state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: GET_BODY, meta: {}, error: null })));
    const wrapper = mountTab();
    await flushPromises();

    // The password input exists but is empty (GET carries no secret).
    const pwInput = wrapper.find('input[type="password"]');
    expect(pwInput.exists()).toBe(true);
    expect((pwInput.element as HTMLInputElement).value).toBe("");

    // "Configured" indicator is shown when smtpConfigured is true.
    expect(wrapper.text()).toContain("Configured");
  });

  it("omits smtpPassword from PATCH when left blank; includes it only when typed", async () => {
    const fetchMock = vi
      .fn()
      // initial GET
      .mockResolvedValueOnce(jsonResponse({ data: GET_BODY, meta: {}, error: null }))
      // first PATCH (blank password)
      .mockResolvedValueOnce(jsonResponse({ data: GET_BODY, meta: {}, error: null }))
      // second PATCH (typed password)
      .mockResolvedValueOnce(jsonResponse({ data: GET_BODY, meta: {}, error: null }));
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mountTab();
    await flushPromises();

    // Save with a blank password.
    const vm = wrapper.vm as unknown as { save: () => Promise<void>; smtpPassword: string };
    await vm.save();
    await flushPromises();

    const patchCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const patchBody = JSON.parse(patchCall[1].body as string) as Record<string, unknown>;
    expect(patchBody).not.toHaveProperty("smtpPassword");

    // Now type a password and save again.
    vm.smtpPassword = "s3cret";
    await vm.save();
    await flushPromises();

    const patchCall2 = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
    const patchBody2 = JSON.parse(patchCall2[1].body as string) as Record<string, unknown>;
    expect(patchBody2.smtpPassword).toBe("s3cret");
  });
});
