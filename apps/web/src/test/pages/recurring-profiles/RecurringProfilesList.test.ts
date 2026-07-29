import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import { createVuetify } from "vuetify";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import { i18n } from "@/plugins/i18n";
import RecurringProfilesList from "@/pages/recurring-profiles/RecurringProfilesList.vue";
import ServerTable from "@/components/tables/ServerTable.vue";

// Mirrors ClientsList.test.ts: proves the i18n slice RENDERS translated strings
// (not raw keys), reacts to a locale switch, and that the page renders through
// the mandated ServerTable (server-table_spec.md §1) — never a raw v-data-table.
const vuetify = createVuetify({ components, directives });

// A minimal router so <v-btn :to> / useRouter() resolve inside the list page.
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { template: "<div/>" } },
    { path: "/recurring-profiles/:id", name: "recurring-profile-detail", component: { template: "<div/>" } },
  ],
});

const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse({ data: [], meta: { total: 0 }, error: null })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const mountList = () => {
  return mount(RecurringProfilesList, {
    global: { plugins: [createPinia(), vuetify, i18n, router] },
  });
};

describe("RecurringProfilesList — i18n slice renders translated strings", () => {
  it("renders the English title and re-renders in Spanish on locale switch", async () => {
    const wrapper = mountList();
    await flushPromises();

    expect(wrapper.text()).toContain("Recurring profiles");
    expect(wrapper.text()).not.toContain("recurring.title");

    i18n.global.locale.value = "es";
    await flushPromises();

    expect(wrapper.text()).toContain("Perfiles recurrentes");
  });
});

describe("RecurringProfilesList — renders through the mandated ServerTable (P0)", () => {
  it("mounts ServerTable and never uses v-data-table-server", async () => {
    const wrapper = mountList();
    await flushPromises();

    expect(wrapper.findComponent(ServerTable).exists()).toBe(true);
    expect(wrapper.findComponent({ name: "VDataTableServer" }).exists()).toBe(false);
  });
});
