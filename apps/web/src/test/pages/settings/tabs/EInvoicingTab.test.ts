import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import EInvoicingTab from "@/pages/settings/tabs/EInvoicingTab.vue";
import en from "@/locales/en.json";
import { confirmState, resolveConfirm } from "@/composables/useConfirm";
import { ok, fail, on, routeFetch, settingsView, polyfillBrowser } from "@/test/helpers/einvoicing";

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/settings/customization/:tab?", name: "settings-customization", component: { template: "<div/>" } },
  ],
});

const BUSINESS = {
  businessName: "Acme",
  legalName: "Acme S.r.l.",
  vatNumber: "IT01234567890",
  taxCode: "01234567890",
  address: { line1: "Via Roma 1", city: "Milano", postalCode: "20100", region: "MI", country: "IT" },
  bankAccounts: [],
};

beforeAll(polyfillBrowser);
beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

const mountTab = async () => {
  const wrapper = mount(EInvoicingTab, { global: { plugins: [createPinia(), vuetify, i18n, router] } });
  await flushPromises();
  return wrapper;
};

const base = (view = settingsView()) =>
  on("GET", "/v1/settings/einvoicing", () => ok(view));
const business = on("GET", "/v1/settings/business", () => ok(BUSINESS));

/** A previously set-up, connected account → the expert view. */
const expert = (over: Parameters<typeof settingsView>[0] = {}) =>
  settingsView({
    connected: true,
    enabled: true,
    enabledAt: "2026-10-01T10:00:00Z",
    passoTenantId: "t1",
    passoSellerId: "s1",
    apiKeyConfigured: true,
    apiKeyLast4: "9f2a",
    ...over,
  });

const READY = [
  { key: "business", ok: true, fix: "business" as const },
  { key: "iban", ok: false, fix: "business" as const },
  { key: "connection", ok: false, fix: "settings" as const },
  { key: "channel", ok: false, fix: "settings" as const },
];

const click = async (w: Awaited<ReturnType<typeof mountTab>>, id: string) => {
  await w.find(`[data-test="${id}"]`).trigger("click");
  await flushPromises();
};
const step = (w: Awaited<ReturnType<typeof mountTab>>): number => (w.findComponent({ name: "EInvoicingWizard" }).vm as unknown as { step: number }).step;

describe("EInvoicingTab — setup wizard", () => {
  it("shows the wizard (not the expert sections) when not connected, starting at step 1 with incomplete company data", async () => {
    routeFetch(base(), business);
    const wrapper = await mountTab();
    expect(wrapper.find('[data-test="einvoicing-wizard"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="einvoicing-save-defaults"]').exists()).toBe(false);
    expect(step(wrapper)).toBe(1);
    expect(wrapper.find('[data-test="wizard-next"]').attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("starts at step 2 when company data is ready; a missing IBAN does NOT block Connect (regression)", async () => {
    const view = settingsView({ adminKeyAvailable: true, mode: "managed", readiness: READY });
    routeFetch(base(view), business);
    const wrapper = await mountTab();
    expect(step(wrapper)).toBe(2);
    expect(wrapper.find('[data-test="connect-blocked"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="einvoicing-connect"]').attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("step 1 lists business as required and IBAN as a non-blocking recommendation; Re-check reloads", async () => {
    const calls = routeFetch(base(settingsView({ readiness: [{ key: "business", ok: true, fix: "business" }, { key: "iban", ok: false, fix: "business" }, ...READY.slice(2)] })), business);
    const wrapper = await mountTab();
    (wrapper.findComponent({ name: "EInvoicingWizard" }).vm as unknown as { step: number }).step = 1;
    await flushPromises();
    expect(wrapper.find('[data-test="wizard-iban-hint"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="wizard-next"]').attributes("disabled")).toBeUndefined();
    const before = calls.filter((c) => c.method === "GET" && c.path === "/v1/settings/einvoicing").length;
    await click(wrapper, "wizard-recheck");
    expect(calls.filter((c) => c.method === "GET" && c.path === "/v1/settings/einvoicing").length).toBe(before + 1);
    wrapper.unmount();
  });

  it("blocks Connect (with the reason) while the business item is open", async () => {
    routeFetch(base(settingsView({ adminKeyAvailable: true, mode: "managed" })), business);
    const wrapper = await mountTab();
    // Step 1 is current (Next is disabled); jump to the Connect pane via the vm.
    (wrapper.findComponent({ name: "EInvoicingWizard" }).vm as unknown as { step: number }).step = 2;
    await flushPromises();
    expect(wrapper.find('[data-test="einvoicing-connect"]').attributes("disabled")).toBeDefined();
    expect(wrapper.find('[data-test="connect-blocked"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("prefills the PASSO URL; Connect provisions, confirms in green and advances to the channel step", async () => {
    const connected = settingsView({
      adminKeyAvailable: true,
      mode: "managed",
      connected: true,
      passoTenantId: "t1",
      passoSellerId: "s1",
      apiKeyConfigured: true,
      apiKeyLast4: "9f2a",
      readiness: READY,
    });
    const calls = routeFetch(
      on("POST", "/v1/settings/einvoicing/provision", () => ok(connected)),
      on("PATCH", "/v1/settings/einvoicing", () => ok(settingsView({ adminKeyAvailable: true, mode: "managed", readiness: READY }))),
      base(settingsView({ adminKeyAvailable: true, mode: "managed", readiness: READY })),
      business,
    );
    const wrapper = await mountTab();
    const urlInput = wrapper.find('[data-test="einvoicing-api-url"] input').element as HTMLInputElement;
    expect(urlInput.value).toBe("https://passo.example.test");

    await click(wrapper, "einvoicing-connect");
    expect(calls.some((c) => c.method === "POST" && c.path === "/v1/settings/einvoicing/provision")).toBe(true);
    expect(wrapper.find('[data-test="wizard-connected"]').text()).toContain("9f2a");
    expect(step(wrapper)).toBe(3);
    expect(wrapper.find('[data-test="einvoicing-channel-form"]').exists()).toBe(true);
    // Channel not configured yet → Next stays disabled.
    expect(wrapper.find('[data-test="wizard-next"]').attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("lists the missing business fields when provisioning is refused", async () => {
    const ready = settingsView({ adminKeyAvailable: true, mode: "managed", readiness: READY });
    routeFetch(
      on("POST", "/v1/settings/einvoicing/provision", () => fail("EINVOICE_BUSINESS_INCOMPLETE", 409, { fields: ["vatNumber", "address.region"] })),
      on("PATCH", "/v1/settings/einvoicing", () => ok(ready)),
      base(ready),
      business,
    );
    const wrapper = await mountTab();
    await click(wrapper, "einvoicing-connect");
    const text = wrapper.find('[data-test="missing-fields"]').text();
    expect(text).toContain("vatNumber");
    expect(text).toContain("address.region");
    wrapper.unmount();
  });

  it("manual mode (no admin key) saves URL + key + seller and skips the channel step", async () => {
    const saved = settingsView({ connected: true, apiKeyConfigured: true, apiKeyLast4: "wxyz", passoSellerId: "s9", readiness: READY });
    const calls = routeFetch(on("PATCH", "/v1/settings/einvoicing", () => ok(saved)), base(settingsView({ readiness: READY })), business);
    const wrapper = await mountTab();
    expect(step(wrapper)).toBe(2);
    expect(wrapper.find('[data-test="einvoicing-connect"]').exists()).toBe(false);

    await wrapper.find('[data-test="einvoicing-api-key"] input').setValue("manual-secret-wxyz");
    await wrapper.find('[data-test="einvoicing-seller-id"] input').setValue("s9");
    await click(wrapper, "einvoicing-save-connection");
    expect(calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ mode: "manual", apiKey: "manual-secret-wxyz", passoSellerId: "s9" });
    expect(step(wrapper)).toBe(4);
    expect(wrapper.html()).not.toContain("manual-secret-wxyz");
    // Back from the test step skips the channel step too.
    await click(wrapper, "wizard-back");
    expect(step(wrapper)).toBe(2);
    wrapper.unmount();
  });

  it("test step: all-green (poll webhook counts) enables Next; Finish saves and enables, flipping to the expert view", async () => {
    const view = settingsView({ connected: true, apiKeyConfigured: true, apiKeyLast4: "9f2a", webhook: { mode: "poll", reason: "no public URL" }, readiness: READY });
    const calls = routeFetch(
      on("POST", "/v1/settings/einvoicing/test", () =>
        ok({ ok: false, checks: [{ key: "api", ok: true }, { key: "key", ok: true }, { key: "channel", ok: true }, { key: "webhook", ok: false, message: "poll" }] }),
      ),
      on("PATCH", "/v1/settings/einvoicing", () => ok(expert())),
      base(view),
      business,
    );
    const wrapper = await mountTab();
    expect(step(wrapper)).toBe(4);
    expect(wrapper.find('[data-test="wizard-next"]').attributes("disabled")).toBeDefined();
    await click(wrapper, "einvoicing-test");
    expect(wrapper.find('[data-test="wizard-next"]').attributes("disabled")).toBeUndefined();
    await click(wrapper, "wizard-next");
    expect(step(wrapper)).toBe(5);

    await click(wrapper, "wizard-finish");
    expect(calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ enabled: true, taxRegime: "RF01", offerStepAfterFinalize: true, bollo: { mode: "auto" } });
    expect(wrapper.find('[data-test="einvoicing-wizard"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="einvoicing-status-header"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("a failing check keeps Next disabled", async () => {
    const view = settingsView({ connected: true, readiness: READY });
    routeFetch(
      on("POST", "/v1/settings/einvoicing/test", () => ok({ ok: false, checks: [{ key: "api", ok: false, message: "down" }] })),
      base(view),
      business,
    );
    const wrapper = await mountTab();
    await click(wrapper, "einvoicing-test");
    expect(wrapper.find('[data-test="wizard-next"]').attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });
});

describe("EInvoicingTab — connected (expert) view", () => {
  it("shows the status header and every expert section", async () => {
    routeFetch(base(expert({ adminKeyAvailable: true, mode: "managed", webhook: { mode: "webhook" }, channel: { type: "pec", configuredAt: "2026-10-01T10:00:00Z", publicConfig: {} }, lastHealth: { ok: true, checkedAt: "2026-10-02T09:00:00Z" } })), business);
    const wrapper = await mountTab();
    expect(wrapper.find('[data-test="einvoicing-wizard"]').exists()).toBe(false);
    const chips = wrapper.find('[data-test="einvoicing-status-chips"]').text();
    expect(chips).toContain("Connected");
    expect(chips).toContain("PEC");
    expect(chips).toContain("9f2a");
    expect(wrapper.find('[data-test="chip-webhook"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="chip-health"]').exists()).toBe(true);
    for (const id of ["einvoicing-enable", "einvoicing-test", "einvoicing-reset", "einvoicing-api-url", "einvoicing-mode", "einvoicing-channel-form", "einvoicing-tax-regime", "einvoicing-bollo-mode", "einvoicing-save-defaults", "einvoicing-save-connection"]) {
      expect(wrapper.find(`[data-test="${id}"]`).exists(), id).toBe(true);
    }
    wrapper.unmount();
  });

  it("stays in the expert view when sending was switched off after a previous setup", async () => {
    routeFetch(base(expert({ enabled: false })), business);
    const wrapper = await mountTab();
    expect(wrapper.find('[data-test="einvoicing-wizard"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("Reset opens the confirm, POSTs /reset, and shows the wizard again", async () => {
    const calls = routeFetch(
      on("POST", "/v1/settings/einvoicing/reset", () => ok(settingsView({ readiness: READY }))),
      base(expert()),
      business,
    );
    const wrapper = await mountTab();
    await wrapper.find('[data-test="einvoicing-reset"]').trigger("click");
    await flushPromises();
    expect(confirmState.open).toBe(true);
    expect(confirmState.message).toContain("NOT deleted");
    expect(calls.some((c) => c.path.endsWith("/reset"))).toBe(false);
    resolveConfirm(true);
    await flushPromises();

    const reset = calls.find((c) => c.path === "/v1/settings/einvoicing/reset")!;
    expect(reset.method).toBe("POST");
    expect(reset.body).toBeUndefined();
    expect(wrapper.find('[data-test="einvoicing-wizard"]').exists()).toBe(true);
    expect(step(wrapper)).toBe(2);
    wrapper.unmount();
  });

  it("Reset does nothing when the confirm is cancelled", async () => {
    const calls = routeFetch(base(expert()), business);
    const wrapper = await mountTab();
    await wrapper.find('[data-test="einvoicing-reset"]').trigger("click");
    await flushPromises();
    resolveConfirm(false);
    await flushPromises();
    expect(calls.some((c) => c.path.endsWith("/reset"))).toBe(false);
    expect(wrapper.find('[data-test="einvoicing-wizard"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("a failing reset keeps the expert view and reports through the snackbar", async () => {
    routeFetch(on("POST", "/v1/settings/einvoicing/reset", () => fail("INTERNAL", 500)), base(expert()), business);
    const wrapper = await mountTab();
    await wrapper.find('[data-test="einvoicing-reset"]').trigger("click");
    await flushPromises();
    resolveConfirm(true);
    await flushPromises();
    expect(wrapper.find('[data-test="einvoicing-wizard"]').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("EInvoicingTab — write-only secrets", () => {
  it("never shows the stored key, omits apiKey when blank and clears it after a save", async () => {
    const view = expert({ mode: "manual" });
    const calls = routeFetch(on("PATCH", "/v1/settings/einvoicing", () => ok(view)), base(view), business);
    const wrapper = await mountTab();

    const keyInput = wrapper.find('[data-test="einvoicing-api-key"] input');
    expect((keyInput.element as HTMLInputElement).value).toBe("");
    expect(wrapper.find('[data-test="chip-key"]').text()).toContain("9f2a");

    // Blank key → no apiKey in the PATCH.
    await wrapper.find('[data-test="einvoicing-save-connection"]').trigger("click");
    await flushPromises();
    const patches = () => calls.filter((c) => c.method === "PATCH");
    expect(patches()[0]!.body).not.toHaveProperty("apiKey");
    expect(patches()[0]!.body).toMatchObject({ mode: "manual", passoSellerId: "s1" });

    // Typed key → sent once, input emptied afterwards, never rendered back.
    await keyInput.setValue("super-secret-key");
    await wrapper.find('[data-test="einvoicing-save-connection"]').trigger("click");
    await flushPromises();
    expect(patches()[1]!.body).toMatchObject({ apiKey: "super-secret-key" });
    expect((wrapper.find('[data-test="einvoicing-api-key"] input').element as HTMLInputElement).value).toBe("");
    expect(wrapper.html()).not.toContain("super-secret-key");
    wrapper.unmount();
  });

  const PASS = { ok: true, smtp: { ok: true }, imap: { ok: true }, mail: { ok: true } };
  const managed = () => settingsView({ adminKeyAvailable: true, mode: "managed", connected: true, readiness: READY });
  type W = Awaited<ReturnType<typeof mountTab>>;
  const pick = async (w: W, type: "pec" | "openapi" | "mock") => {
    await w.find(`[data-test="channel-card-${type}"]`).trigger("click");
    await flushPromises();
  };
  const fillPec = async (w: W, password = "pec-pass") => {
    await pick(w, "pec");
    await w.find('[data-test="pec-smtp-host"] input').setValue("smtps.pec.example.it");
    await w.find('[data-test="pec-imap-host"] input').setValue("imaps.pec.example.it");
    await w.find('[data-test="pec-user"] input').setValue("billy@pec.example.it");
    await w.find('[data-test="channel-pec-password"] input').setValue(password);
    await w.find('[data-test="pec-test-to"] input').setValue("me@example.com");
  };
  const runPecTest = async (w: W) => {
    await w.find('[data-test="pec-test-run"]').trigger("click");
    await flushPromises();
  };
  const saveDisabled = (w: W): boolean => (w.find('[data-test="channel-save"]').element as HTMLButtonElement).disabled;

  it("PEC save is locked until the test passes; password goes out in the PUT and is cleared afterwards", async () => {
    const view = managed();
    const calls = routeFetch(
      on("POST", "/v1/settings/einvoicing/channel/test", () => ok(PASS)),
      on("PUT", "/v1/settings/einvoicing/channel", () => ok({ view })),
      base(view),
      business,
    );
    const wrapper = await mountTab();
    await fillPec(wrapper);
    expect(saveDisabled(wrapper)).toBe(true);
    await runPecTest(wrapper);

    const test = calls.find((c) => c.path.endsWith("/channel/test"))!;
    expect(test.body).toMatchObject({ to: "me@example.com", config: { password: "pec-pass" } });
    expect(wrapper.find('[data-test="pec-test-smtp"]').attributes("data-ok")).toBe("true");
    expect(wrapper.find('[data-test="pec-test-passed"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="pec-test-mail"]').text()).toContain("me@example.com");
    expect(saveDisabled(wrapper)).toBe(false);

    await wrapper.find('[data-test="channel-save"]').trigger("click");
    await flushPromises();
    const put = calls.find((c) => c.method === "PUT")!;
    expect((put.body as { config: Record<string, unknown> }).config.password).toBe("pec-pass");
    expect((wrapper.find('[data-test="channel-pec-password"] input').element as HTMLInputElement).value).toBe("");
    wrapper.unmount();
  });

  it("a failed PEC test shows the reasons and keeps save locked", async () => {
    routeFetch(
      on("POST", "/v1/settings/einvoicing/channel/test", () =>
        ok({ ok: false, smtp: { ok: false, message: "535 Authentication failed for pec-pass" }, imap: { ok: true }, mail: { ok: false, message: "skipped" } }),
      ),
      base(managed()),
      business,
    );
    const wrapper = await mountTab();
    await fillPec(wrapper);
    await runPecTest(wrapper);
    expect(wrapper.find('[data-test="pec-test-smtp"]').attributes("data-ok")).toBe("false");
    expect(wrapper.find('[data-test="pec-test-smtp-reason"]').text()).toBe("Wrong username or password.");
    expect(wrapper.find('[data-test="pec-test-mail-reason"]').text()).toBe("skipped");
    expect(wrapper.text()).not.toContain("pec-pass");
    expect(wrapper.find('[data-test="pec-test-failed"]').exists()).toBe(true);
    expect(saveDisabled(wrapper)).toBe(true);
    wrapper.unmount();
  });

  it("editing a PEC field after a pass re-locks save with a hint; the recipient is not part of it", async () => {
    routeFetch(on("POST", "/v1/settings/einvoicing/channel/test", () => ok(PASS)), base(managed()), business);
    const wrapper = await mountTab();
    await fillPec(wrapper);
    await runPecTest(wrapper);
    expect(saveDisabled(wrapper)).toBe(false);

    await wrapper.find('[data-test="pec-test-to"] input').setValue("other@example.com");
    expect(saveDisabled(wrapper)).toBe(false);

    await wrapper.find('[data-test="channel-pec-password"] input').setValue("changed");
    expect(saveDisabled(wrapper)).toBe(true);
    expect(wrapper.find('[data-test="pec-test-stale"]').text()).toContain("Run the test again");
    wrapper.unmount();
  });

  it("pec.test_required on save and a forbidden recipient get clear messages", async () => {
    const view = managed();
    routeFetch(
      on("POST", "/v1/settings/einvoicing/channel/test", (c) =>
        (c.body as { to: string }).to.endsWith("fatturapa.it") ? fail("VALIDATION", 400, { to: "pec.test_recipient_forbidden" }) : ok(PASS),
      ),
      on("PUT", "/v1/settings/einvoicing/channel", () => fail("CONFLICT", 409, { channel: "pec.test_required" })),
      base(view),
      business,
    );
    const wrapper = await mountTab();
    await fillPec(wrapper);
    await wrapper.find('[data-test="pec-test-to"] input').setValue("x@sdi.fatturapa.it");
    await runPecTest(wrapper);
    expect(wrapper.text()).toContain("cannot receive the test email");
    expect(saveDisabled(wrapper)).toBe(true);

    await wrapper.find('[data-test="pec-test-to"] input').setValue("me@example.com");
    await runPecTest(wrapper);
    await wrapper.find('[data-test="channel-save"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Run the connection test with these exact settings");
    wrapper.unmount();
  });

  it("the PEC test button validates the form first: empty SMTP fields -> no API call, field errors shown", async () => {
    const view = managed();
    const calls = routeFetch(on("POST", "/v1/settings/einvoicing/channel/test", () => ok(PASS)), base(view), business);
    const wrapper = await mountTab();
    await pick(wrapper, "pec");
    await wrapper.find('[data-test="pec-test-to"] input').setValue("");
    await runPecTest(wrapper);
    expect(calls.some((c) => c.method === "POST" && c.path.includes("/channel/test"))).toBe(false);
    const text = wrapper.find('[data-test="pec-form"]').text();
    expect(text.match(/This field is required/g)?.length).toBeGreaterThanOrEqual(4);
    expect(wrapper.find('[data-test="pec-test-result"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("the PEC test button rejects a URL as host and an out-of-range port without calling the API", async () => {
    const view = managed();
    const calls = routeFetch(on("POST", "/v1/settings/einvoicing/channel/test", () => ok(PASS)), base(view), business);
    const wrapper = await mountTab();
    await fillPec(wrapper);
    await wrapper.find('[data-test="pec-smtp-host"] input').setValue("https://smtps.pec.example.it/x");
    await wrapper.find('[data-test="pec-smtp-port"] input').setValue("70000");
    await wrapper.find('[data-test="pec-test-to"] input').setValue("not-an-email");
    await runPecTest(wrapper);
    expect(calls.some((c) => c.path.includes("/channel/test"))).toBe(false);
    const text = wrapper.find('[data-test="pec-form"]').text();
    expect(text).toContain("Enter a valid host name");
    expect(text).toContain("Enter a port between 1 and 65535");
    expect(text).toContain("Enter a valid email address");
    wrapper.unmount();
  });

  it("the OpenAPI.it test button validates the token first", async () => {
    const view = managed();
    const calls = routeFetch(on("POST", "/v1/settings/einvoicing/channel/test-openapi", () => ok({ ok: true, checks: [] })), base(view), business);
    const wrapper = await mountTab();
    await pick(wrapper, "openapi");
    await wrapper.find('[data-test="openapi-test-run"]').trigger("click");
    await flushPromises();
    expect(calls.some((c) => c.path.includes("test-openapi"))).toBe(false);
    expect(wrapper.find('[data-test="openapi-form"]').text()).toContain("This field is required");
    wrapper.unmount();
  });

  const OA_PASS = { ok: true, checks: [{ key: "token", ok: true }, { key: "registry", ok: true }, { key: "signing", ok: true }] };
  const fillOa = async (w: W, token = "tok-123") => {
    await pick(w, "openapi");
    await w.find('[data-test="channel-openapi-token"] input').setValue(token);
  };
  const runOaTest = async (w: W) => {
    await w.find('[data-test="openapi-test-run"]').trigger("click");
    await flushPromises();
  };

  it("the chooser shows OpenAPI.it and PEC (mock only when allowed), preselects the saved one and swaps the forms", async () => {
    routeFetch(base(managed()), business);
    const wrapper = await mountTab();
    expect(wrapper.find('[data-test="channel-card-openapi"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="channel-card-pec"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="channel-card-mock"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="channel-card-openapi"]').text()).toContain("public-administration (B2G)");
    expect(wrapper.find('[data-test="channel-card-pec"]').text()).toContain("B2B invoices only");
    // Nothing chosen yet: no form, no Save.
    expect(wrapper.find('[data-test="pec-test"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="channel-save"]').exists()).toBe(false);
    await pick(wrapper, "pec");
    expect(wrapper.find('[data-test="channel-card-pec"]').attributes("data-selected")).toBe("true");
    expect(wrapper.find('[data-test="pec-test"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="pec-notice"]').text()).toContain("accredited with SdI");
    await pick(wrapper, "openapi");
    expect(wrapper.find('[data-test="pec-test"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="openapi-form"]').exists()).toBe(true);
    wrapper.unmount();

    routeFetch(base(expert({ adminKeyAvailable: true, mode: "managed", mockAllowed: true, channel: { type: "openapi", configuredAt: "2026-10-01T10:00:00Z", publicConfig: { baseUrl: "https://sdi.openapi.it", requestSigning: true } } })), business);
    const w2 = await mountTab();
    expect(w2.find('[data-test="channel-card-mock"]').exists()).toBe(true);
    expect(w2.find('[data-test="channel-card-openapi"]').attributes("data-selected")).toBe("true");
    expect(w2.find('[data-test="openapi-prod-warning"]').exists()).toBe(true);
    w2.unmount();
  });

  it("the OpenAPI.it notice is open by default with the steps, the endpoint table and the VAT number without prefix", async () => {
    routeFetch(base(managed()), on("GET", "/v1/settings/business", () => ok(BUSINESS)));
    const wrapper = await mountTab();
    await pick(wrapper, "openapi");
    const text = wrapper.find('[data-test="openapi-notice"]').text();
    expect(text).toContain("What to enable on OpenAPI.it");
    for (const n of [1, 2, 3, 4, 5]) expect(wrapper.find(`[data-test="notice-step-${n}"]`).exists()).toBe(true);
    expect(wrapper.find('[data-test="notice-endpoint-send"]').text()).toContain("POST /invoices");
    expect(wrapper.find('[data-test="notice-endpoint-read"]').text()).toContain("GET /invoices/{uuid}");
    expect(wrapper.find('[data-test="notice-fiscal-id"]').text()).toContain("01234567890");
    expect(wrapper.find('[data-test="notice-fiscal-id"]').text()).not.toContain("IT01234567890");
    expect(text).toContain("Start with Sandbox");
    wrapper.unmount();
  });

  it("OpenAPI.it: save is locked until the test passes; the token goes out once in the PUT (sandbox URL by default) and is cleared; the inbound URL is shown with a copy button", async () => {
    const view = managed();
    const saved = settingsView({
      adminKeyAvailable: true,
      mode: "managed",
      connected: true,
      channel: { type: "openapi", configuredAt: "2026-10-02T10:00:00Z", publicConfig: { baseUrl: "https://test.sdi.openapi.it", requestSigning: false } },
    });
    const calls = routeFetch(
      on("POST", "/v1/settings/einvoicing/channel/test-openapi", () => ok(OA_PASS)),
      on("PUT", "/v1/settings/einvoicing/channel", () => ok({ view: saved, inboundWebhookUrl: "https://billy.example/hook/abc" })),
      base(view),
      business,
    );
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const wrapper = await mountTab();
    await fillOa(wrapper);
    expect(saveDisabled(wrapper)).toBe(true);
    expect(wrapper.find('[data-test="openapi-prod-warning"]').exists()).toBe(false);
    await runOaTest(wrapper);

    const test = calls.find((c) => c.path.endsWith("/channel/test-openapi"))!;
    expect(test.body).toEqual({ config: { token: "tok-123", baseUrl: "https://test.sdi.openapi.it", requestSigning: false } });
    expect(wrapper.find('[data-test="openapi-test-token"]').attributes("data-ok")).toBe("true");
    expect(wrapper.find('[data-test="openapi-test-passed"]').exists()).toBe(true);
    expect(saveDisabled(wrapper)).toBe(false);

    await wrapper.find('[data-test="channel-save"]').trigger("click");
    await flushPromises();
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({ type: "openapi", config: { token: "tok-123", baseUrl: "https://test.sdi.openapi.it", requestSigning: false } });
    expect((wrapper.find('[data-test="channel-openapi-token"] input').element as HTMLInputElement).value).toBe("");
    expect(wrapper.html()).not.toContain("tok-123");
    expect(wrapper.find('[data-test="channel-inbound-value"]').text()).toBe("https://billy.example/hook/abc");
    expect(wrapper.find('[data-test="channel-inbound-optional"]').text()).toContain("polling");
    await wrapper.find('[data-test="channel-inbound-copy"]').trigger("click");
    expect(writeText).toHaveBeenCalledWith("https://billy.example/hook/abc");
    wrapper.unmount();
  });

  it("a failed OpenAPI.it test shows the three rows with remedies and keeps save locked", async () => {
    routeFetch(
      on("POST", "/v1/settings/einvoicing/channel/test-openapi", () =>
        ok({ ok: false, checks: [{ key: "token", ok: true }, { key: "registry", ok: false }, { key: "signing", ok: false, message: "registry has signing ON tok-123" }] }),
      ),
      base(managed()),
      business,
    );
    const wrapper = await mountTab();
    await fillOa(wrapper);
    await runOaTest(wrapper);
    expect(wrapper.find('[data-test="openapi-test-token"]').attributes("data-ok")).toBe("true");
    expect(wrapper.find('[data-test="openapi-test-registry"]').attributes("data-ok")).toBe("false");
    expect(wrapper.find('[data-test="openapi-test-registry-remedy"]').text()).toContain("Register your company");
    expect(wrapper.find('[data-test="openapi-test-signing-remedy"]').text()).toContain("match the signing option");
    expect(wrapper.find('[data-test="openapi-test-signing-detail"]').text()).toContain("signing ON");
    expect(wrapper.text()).not.toContain("tok-123");
    expect(wrapper.find('[data-test="openapi-test-failed"]').exists()).toBe(true);
    expect(saveDisabled(wrapper)).toBe(true);
    wrapper.unmount();
  });

  it("editing the token, environment or signing after a pass re-locks save; Production shows the warning", async () => {
    routeFetch(on("POST", "/v1/settings/einvoicing/channel/test-openapi", () => ok(OA_PASS)), base(managed()), business);
    const wrapper = await mountTab();
    await fillOa(wrapper);
    await runOaTest(wrapper);
    expect(saveDisabled(wrapper)).toBe(false);

    await wrapper.find('[data-test="channel-openapi-token"] input').setValue("tok-456");
    expect(saveDisabled(wrapper)).toBe(true);
    expect(wrapper.find('[data-test="openapi-test-stale"]').exists()).toBe(true);
    await runOaTest(wrapper);
    expect(saveDisabled(wrapper)).toBe(false);

    await wrapper.find('[data-test="channel-openapi-signing"] input').setValue(true);
    expect(saveDisabled(wrapper)).toBe(true);
    await runOaTest(wrapper);
    expect(saveDisabled(wrapper)).toBe(false);

    (wrapper.findComponent({ name: "EInvoicingChannelForm" }).vm as unknown as { env: string }).env = "production";
    await flushPromises();
    expect(wrapper.find('[data-test="openapi-prod-warning"]').text()).toContain("Real invoices");
    expect(saveDisabled(wrapper)).toBe(true);
    wrapper.unmount();
  });

  it("openapi.test_required on save gets a clear message", async () => {
    routeFetch(
      on("POST", "/v1/settings/einvoicing/channel/test-openapi", () => ok(OA_PASS)),
      on("PUT", "/v1/settings/einvoicing/channel", () => fail("CONFLICT", 409, { channel: "openapi.test_required" })),
      base(managed()),
      business,
    );
    const wrapper = await mountTab();
    await fillOa(wrapper);
    await runOaTest(wrapper);
    await wrapper.find('[data-test="channel-save"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Run the connection test with these exact settings");
    wrapper.unmount();
  });

  it("the wizard channel step blocks Next while PEC edits are untested", async () => {
    const view = settingsView({ adminKeyAvailable: true, mode: "managed", connected: true, readiness: READY, channel: { type: "pec", configuredAt: "2026-10-01T10:00:00Z", publicConfig: {} } });
    routeFetch(on("POST", "/v1/settings/einvoicing/channel/test", () => ok(PASS)), base(view), business);
    const wrapper = await mountTab();
    const next = () => (wrapper.find('[data-test="wizard-next"]').element as HTMLButtonElement).disabled;
    expect(step(wrapper)).toBe(4);
    await wrapper.find('[data-test="wizard-step-3"]').trigger("click");
    expect(step(wrapper)).toBe(3);
    expect(next()).toBe(false);
    await wrapper.find('[data-test="channel-pec-password"] input').setValue("new-pass");
    expect(next()).toBe(true);
    await wrapper.find('[data-test="pec-smtp-host"] input').setValue("smtps.pec.example.it");
    await wrapper.find('[data-test="pec-imap-host"] input').setValue("imaps.pec.example.it");
    await wrapper.find('[data-test="pec-user"] input').setValue("billy@pec.example.it");
    await wrapper.find('[data-test="pec-test-to"] input').setValue("me@example.com");
    await runPecTest(wrapper);
    expect(next()).toBe(false);
    wrapper.unmount();
  });

  it("the stepper shows a check for completed steps, numbers for pending ones, and primary dividers", async () => {
    const view = settingsView({ adminKeyAvailable: true, mode: "managed", connected: true, readiness: READY, channel: { type: "pec", configuredAt: "2026-10-01T10:00:00Z", publicConfig: {} } });
    routeFetch(base(view), business);
    const wrapper = await mountTab();
    await wrapper.find('[data-test="wizard-step-3"]').trigger("click");
    expect(step(wrapper)).toBe(3);
    const item = (n: number) => wrapper.find(`[data-test="wizard-step-${n}"]`);
    expect(item(1).attributes("data-state")).toBe("complete");
    expect(item(1).find(".mdi-check").exists()).toBe(true);
    expect(item(1).text()).not.toMatch(/^1/);
    expect(item(3).attributes("data-state")).toBe("active");
    expect(item(3).find(".v-stepper-item__avatar").text()).toBe("3");
    expect(item(5).attributes("data-state")).toBe("pending");
    expect(item(5).find(".v-stepper-item__avatar").text()).toBe("5");
    expect(item(5).find(".mdi-check").exists()).toBe(false);
    expect(wrapper.find('[data-test="wizard-divider-1"]').attributes("data-done")).toBe("true");
    expect(wrapper.find('[data-test="wizard-divider-4"]').attributes("data-done")).toBe("false");
    wrapper.unmount();
  });
});

describe("EInvoicingTab — setup guide readiness", () => {
  it("shows live check / cross marks from readiness (and local state for the rest)", async () => {
    routeFetch(
      base(
        expert({
          enabled: false,
          readiness: [
            { key: "business", ok: true, fix: "business" },
            { key: "iban", ok: false, fix: "business" },
            { key: "connection", ok: true, fix: "settings" },
            { key: "channel", ok: false, fix: "settings" },
          ],
        }),
      ),
      business,
    );
    const wrapper = await mountTab();
    const state = (step: string): string | undefined =>
      wrapper.find(`[data-test="guide-step-${step}"] [data-state]`).attributes("data-state");
    expect(state("company")).toBe("ok");
    expect(state("iban")).toBe("todo");
    expect(state("connect")).toBe("ok");
    expect(state("channel")).toBe("todo");
    // The guide carries the deadline note and the NS / MC / AT box.
    expect(wrapper.find('[data-test="guide-send-later"]').text()).toContain("12");
    const box = wrapper.find('[data-test="guide-statuses"]').text();
    expect(box).toContain("NS");
    expect(box).toContain("MC");
    expect(box).toContain("AT");
    // Not enabled + pending steps → the enable switch warns about what is open.
    expect(wrapper.find('[data-test="einvoicing-incomplete"]').text()).toContain("IBAN");
    wrapper.unmount();
  });

  it("marks the business summary with a cross for missing seller data", async () => {
    routeFetch(
      base(expert()),
      on("GET", "/v1/settings/business", () =>
        ok({ ...BUSINESS, address: { ...BUSINESS.address, region: "" } }),
      ),
    );
    const wrapper = await mountTab();
    expect(wrapper.find('[data-test="biz-province"] .mdi-close-circle').exists()).toBe(true);
    expect(wrapper.find('[data-test="biz-vat"] .mdi-check-circle').exists()).toBe(true);
    wrapper.unmount();
  });
});

describe("EInvoicingTab — actions", () => {
  it("the master switch PATCHes enabled", async () => {
    const calls = routeFetch(on("PATCH", "/v1/settings/einvoicing", () => ok(expert({ enabled: true }))), base(expert({ enabled: false })), business);
    const wrapper = await mountTab();
    await wrapper.find('[data-test="einvoicing-enable"] input').setValue(true);
    await flushPromises();
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ enabled: true });
    wrapper.unmount();
  });

  it("Test connection lists each check", async () => {
    routeFetch(
      on("POST", "/v1/settings/einvoicing/test", () =>
        ok({
          ok: false,
          checks: [
            { key: "api", ok: true },
            { key: "key", ok: true },
            { key: "channel", ok: false, message: "PEC login refused" },
            { key: "webhook", ok: true },
          ],
        }),
      ),
      base(expert()),
      business,
    );
    const wrapper = await mountTab();
    await wrapper.find('[data-test="einvoicing-test"]').trigger("click");
    await flushPromises();
    const res = wrapper.find('[data-test="einvoicing-test-result"]');
    expect(res.text()).toContain("Some checks failed");
    expect(res.find('[data-test="check-channel"]').text()).toContain("PEC login refused");
    expect(res.find('[data-test="check-api"] .mdi-check').exists()).toBe(true);
    wrapper.unmount();
  });

  it("saving defaults PATCHes the fiscal profile and behaviour fields", async () => {
    const calls = routeFetch(on("PATCH", "/v1/settings/einvoicing", () => ok(expert())), base(expert()), business);
    const wrapper = await mountTab();
    await wrapper.find('[data-test="einvoicing-save-defaults"]').trigger("click");
    await flushPromises();
    expect(calls.find((c) => c.method === "PATCH")!.body).toMatchObject({
      taxRegime: "RF01",
      offerStepAfterFinalize: true,
      scheduledDefaultSubmit: false,
      recurringDefaultSubmit: false,
      defaultPaymentConditions: "TP02",
      defaultPaymentMethod: "MP05",
      bollo: { mode: "auto", threshold: "77.47", amount: "2.00" },
      creditNoteNumberPrefix: "NC",
      sendDeadlineDays: 12,
    });
    wrapper.unmount();
  });
});
