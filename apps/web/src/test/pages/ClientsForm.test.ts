import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import ClientsForm from "@/pages/ClientsForm.vue";
import en from "@/locales/en.json";

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

const push = vi.fn();
// Route mode is toggled per-test via this mutable holder.
const routeParams: { params: Record<string, string> } = { params: {} };
vi.mock("vue-router", () => ({
  useRoute: () => routeParams,
  useRouter: () => ({ back: vi.fn(), push }),
}));

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as unknown as { visualViewport?: unknown }).visualViewport ??= {
    width: 1024,
    height: 768,
    offsetLeft: 0,
    offsetTop: 0,
    scale: 1,
    addEventListener() {},
    removeEventListener() {},
  };
});

const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
};

interface Captured {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
  ifMatch: string | null;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
  push.mockClear();
  routeParams.params = {};
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ClientsForm create mode", () => {
  it("POSTs the correct company shape (type + displayName + legalName + address)", async () => {
    const captured: Captured[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        if (init?.method === "POST" && url.endsWith("/v1/clients")) {
          captured.push({
            method: "POST",
            url,
            body: init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
            ifMatch: (init.headers as Record<string, string>)?.["If-Match"] ?? null,
          });
          return jsonResponse({ data: { id: "cli_1", version: 1 }, meta: {}, error: null }, 201);
        }
        return jsonResponse({ data: {}, meta: {}, error: null });
      }),
    );

    const wrapper = mount(ClientsForm, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();

    const vm = wrapper.vm as unknown as {
      displayName: string;
      legalName: string;
      email: string;
      addrLine1: string;
      addrCity: string;
      addrPostalCode: string;
      addrCountry: string;
      save: () => Promise<void>;
    };
    vm.displayName = "Acme SpA";
    vm.legalName = "Acme Società per Azioni";
    vm.email = "billing@acme.example";
    vm.addrLine1 = "Via Roma 1";
    vm.addrCity = "Milano";
    vm.addrPostalCode = "20100";
    vm.addrCountry = "IT";
    await vm.save();
    await flushPromises();

    expect(captured).toHaveLength(1);
    const body = captured[0]!.body!;
    expect(body.type).toBe("company");
    expect(body.displayName).toBe("Acme SpA");
    expect(body.legalName).toBe("Acme Società per Azioni");
    expect(body.email).toBe("billing@acme.example");
    expect(body.billingAddress).toEqual({
      line1: "Via Roma 1",
      city: "Milano",
      postalCode: "20100",
      country: "IT",
    });
    // firstName/lastName must NOT be sent for a company.
    expect(body.firstName).toBeUndefined();
    expect(push).toHaveBeenCalledWith({ name: "clients" });
  });

  it("POSTs individual naming fields and omits an empty address", async () => {
    const captured: Captured[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        if (init?.method === "POST" && url.endsWith("/v1/clients")) {
          captured.push({
            method: "POST",
            url,
            body: init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
            ifMatch: null,
          });
          return jsonResponse({ data: { id: "cli_2", version: 1 }, meta: {}, error: null }, 201);
        }
        return jsonResponse({ data: {}, meta: {}, error: null });
      }),
    );

    const wrapper = mount(ClientsForm, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();

    const vm = wrapper.vm as unknown as {
      type: string;
      displayName: string;
      firstName: string;
      lastName: string;
      save: () => Promise<void>;
    };
    vm.type = "individual";
    vm.displayName = "Jane Doe";
    vm.firstName = "Jane";
    vm.lastName = "Doe";
    await vm.save();
    await flushPromises();

    const body = captured[0]!.body!;
    expect(body.type).toBe("individual");
    expect(body.firstName).toBe("Jane");
    expect(body.lastName).toBe("Doe");
    expect(body.legalName).toBeUndefined();
    // No address fields filled → billingAddress omitted entirely.
    expect(body.billingAddress).toBeUndefined();
  });
});

describe("ClientsForm edit mode", () => {
  it("loads via GET and PATCHes with the If-Match version", async () => {
    routeParams.params = { id: "cli_9" };
    const captured: Captured[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        const method = init?.method ?? "GET";
        if (method === "GET" && url.endsWith("/v1/clients/cli_9")) {
          return jsonResponse(
            {
              data: {
                id: "cli_9",
                version: 4,
                type: "company",
                displayName: "Old Name",
                legalName: "Old Legal",
                email: "old@x.example",
                tags: ["vip"],
              },
              meta: {},
              error: null,
            },
            200,
          );
        }
        if (method === "PATCH" && url.endsWith("/v1/clients/cli_9")) {
          captured.push({
            method,
            url,
            body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
            ifMatch: (init?.headers as Record<string, string>)?.["If-Match"] ?? null,
          });
          return jsonResponse({ data: { id: "cli_9", version: 5 }, meta: {}, error: null }, 200);
        }
        return jsonResponse({ data: {}, meta: {}, error: null });
      }),
    );

    const wrapper = mount(ClientsForm, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();

    const vm = wrapper.vm as unknown as {
      displayName: string;
      legalName: string;
      save: () => Promise<void>;
    };
    // Loaded values populated the fields.
    expect(vm.displayName).toBe("Old Name");
    expect(vm.legalName).toBe("Old Legal");

    vm.displayName = "New Name";
    await vm.save();
    await flushPromises();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.ifMatch).toBe("4");
    expect(captured[0]!.body!.displayName).toBe("New Name");
    expect(captured[0]!.body!.type).toBe("company");
    expect(push).toHaveBeenCalledWith({ name: "clients" });
  });
});
