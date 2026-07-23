import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import SubscriptionForm from "@/pages/subscriptions/SubscriptionForm.vue";
import en from "@/locales/en.json";

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

const push = vi.fn();
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: {} }),
  useRouter: () => ({ back: vi.fn(), push }),
}));

// The client dropdown does its own async searching; stub it so the create-shape
// assertions here aren't racing its fetch. The v-model still drives clientId.
vi.mock("@/components/ClientSelector.vue", () => ({
  default: { name: "ClientSelector", template: "<div />" },
}));
vi.mock("@/components/ProjectSelect.vue", () => ({
  default: { name: "ProjectSelect", template: "<div />" },
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

let posts: { body: Record<string, unknown> | null }[] = [];

const stubFetch = (): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (init?.method === "POST" && url.endsWith("/v1/subscriptions")) {
        posts.push({
          body: init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
        });
        return jsonResponse({ data: { id: "sub_1", version: 1 }, meta: {}, error: null }, 201);
      }
      return jsonResponse({ data: {}, meta: {}, error: null });
    }),
  );
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
  push.mockClear();
  posts = [];
  stubFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SubscriptionForm optional client", () => {
  it("omits clientId entirely when no client is selected, and sends url/note", async () => {
    const wrapper = mount(SubscriptionForm, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();

    const vm = wrapper.vm as unknown as {
      clientId: string | null;
      name: string;
      plan: string;
      amountMajor: number | null;
      url: string;
      note: string;
      save: () => Promise<void>;
    };
    vm.clientId = null; // no client
    vm.name = "Pro plan";
    vm.plan = "pro";
    vm.amountMajor = 49;
    vm.url = "https://vendor.example/billing";
    vm.note = "Renews annually";
    await vm.save();
    await flushPromises();

    expect(posts).toHaveLength(1);
    const body = posts[0]!.body!;
    expect("clientId" in body).toBe(false);
    expect(body.name).toBe("Pro plan");
    expect(body.amountMinor).toBe(4900);
    expect(body.url).toBe("https://vendor.example/billing");
    expect(body.note).toBe("Renews annually");
    expect(push).toHaveBeenCalledWith({ name: "subscriptions" });
  });

  it("includes clientId when one is selected", async () => {
    const wrapper = mount(SubscriptionForm, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();

    const vm = wrapper.vm as unknown as {
      clientId: string | null;
      name: string;
      plan: string;
      amountMajor: number | null;
      save: () => Promise<void>;
    };
    vm.clientId = "cli_42";
    vm.name = "Basic";
    vm.plan = "basic";
    vm.amountMajor = 10;
    await vm.save();
    await flushPromises();

    const body = posts[0]!.body!;
    expect(body.clientId).toBe("cli_42");
  });
});
