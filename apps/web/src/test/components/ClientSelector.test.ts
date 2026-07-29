import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import { i18n } from "@/plugins/i18n";
import ClientSelector from "@/components/ClientSelector.vue";
import AutocompleteSearch from "@/components/AutocompleteSearch.vue";
import type { Client } from "@/types/domain";

const vuetify = createVuetify({ components, directives });

const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

const client = (over: Partial<Client> = {}): Client => {
  return {
    id: over.id ?? "c1",
    type: "company",
    displayName: over.displayName ?? "Acme Corp",
    country: "US",
    preferredCurrency: "USD",
    version: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    ...over,
  };
};

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

beforeEach(() => {
  i18n.global.locale.value = "en";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const mountSelector = (modelValue: string | null) => {
  return mount(ClientSelector, {
    props: { modelValue },
    global: { plugins: [vuetify, i18n] },
  });
};

describe("ClientSelector", () => {
  it("queries the clients list endpoint on mount", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ data: [client()], meta: { total: 1 }, error: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    mountSelector(null);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalled();
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const url = String(firstCall?.[0]);
    expect(url).toContain("/v1/clients");
    const init = firstCall?.[1] as unknown as RequestInit;
    expect(init.credentials).toBe("include");
  });

  it("emits update:modelValue with the selected client id", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [client({ id: "c1" }), client({ id: "c2", displayName: "Beta" })], meta: { total: 2 }, error: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mountSelector(null);
    await flushPromises();

    // Drive the AutocompleteSearch child's model update directly (ClientSelector
    // now wraps AutocompleteSearch server-mode; emulates the user selecting).
    const autocomplete = wrapper.findComponent(AutocompleteSearch);
    autocomplete.vm.$emit("update:modelValue", "c2");
    await flushPromises();

    const emitted = wrapper.emitted("update:modelValue");
    expect(emitted).toBeTruthy();
    expect(emitted?.[emitted.length - 1]).toEqual(["c2"]);
  });

  it("fetches the single selected client (edit-mode seed) so its name renders", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/v1\/clients\/c9(\?|$)/u.test(url)) {
        return jsonResponse({ data: client({ id: "c9", displayName: "Preloaded" }), meta: {}, error: null });
      }
      // list request (no id): return other clients, NOT c9
      return jsonResponse({ data: [client({ id: "c1" })], meta: { total: 1 }, error: null });
    });
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mountSelector("c9");
    await flushPromises();

    const singleFetch = fetchMock.mock.calls.find(([u]) => /\/v1\/clients\/c9/u.test(String(u)));
    expect(singleFetch).toBeDefined();

    // The seeded (edit-mode) client must actually RESOLVE to its display name —
    // proves the seed reaches the select's items, not just that the fetch fired.
    expect(wrapper.text()).toContain("Preloaded");
  });
});
