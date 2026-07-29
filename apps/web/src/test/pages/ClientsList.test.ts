import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createVuetify } from "vuetify";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import { i18n } from "@/plugins/i18n";
import ClientsList from "@/pages/ClientsList.vue";
import ServerTable from "@/components/tables/ServerTable.vue";
import RowActionMenu from "@/components/tables/RowActionMenu.vue";
import type { RowAction } from "@/components/tables/RowActionMenu.vue";
import { useAuthStore } from "@/stores/auth";
import type { Client, Principal } from "@/types/domain";

// This test proves the i18n slice actually RENDERS translated strings (not raw
// keys) and reacts to a locale switch — the one assertion that validates the
// whole vue-i18n wiring end to end.
// ClientsList uses useRouter() for the Add/Edit CTAs. The i18n/render assertions
// here don't navigate, so a minimal router stub silences the injection warning.
vi.mock("vue-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const vuetify = createVuetify({ components, directives });

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

const principalWith = (canPermanentlyDelete: boolean): Principal =>
  ({
    userId: "u1",
    role: canPermanentlyDelete ? "administrator" : "member",
    accountId: "default",
    capabilities: {
      canManageSettings: canPermanentlyDelete,
      canManageUsers: canPermanentlyDelete,
      canPermanentlyDelete,
      canViewFinancialTotals: canPermanentlyDelete,
      canExportData: canPermanentlyDelete,
    },
  }) as Principal;

const mountList = (principal?: Principal) => {
  // Pinia is required: ClientsList calls useSettingsStore().load() on mount and
  // ServerTable → ColManager reads the settings store in its own onMounted.
  const pinia = createPinia();
  setActivePinia(pinia);
  if (principal) useAuthStore().principal = principal;
  return mount(ClientsList, { global: { plugins: [pinia, vuetify, i18n] } });
};

describe("ClientsList — i18n slice renders translated strings", () => {
  it("renders the English title and re-renders in Spanish on locale switch", async () => {
    const wrapper = mountList();
    await flushPromises();

    // English: proves t() resolves the global message (not the raw key).
    expect(wrapper.text()).toContain("Clients");
    expect(wrapper.text()).not.toContain("clients.title");

    i18n.global.locale.value = "es";
    await flushPromises();

    expect(wrapper.text()).toContain("Clientes");
  });
});

describe("ClientsList — renders through the mandated ServerTable (P0)", () => {
  // Regression guard: server-table_spec.md §1 requires every list page to render
  // through ServerTable.vue. Assert the component is present and that the raw
  // v-data-table-server was fully removed, so the rule can't silently regress.
  it("mounts ServerTable and no longer uses v-data-table-server", async () => {
    const wrapper = mountList();
    await flushPromises();

    expect(wrapper.findComponent(ServerTable).exists()).toBe(true);
    expect(wrapper.findComponent({ name: "VDataTableServer" }).exists()).toBe(false);
  });
});

// ── Lifecycle row actions (archive / restore / delete) ────────────────────────

const CLIENT_ROW: Partial<Client> = {
  id: "c1",
  version: 1,
  type: "company",
  displayName: "Acme SpA",
  archivedAt: null,
};

const listResponseWith = (rows: unknown[]) =>
  vi.fn(async () => jsonResponse({ data: rows, meta: { total: rows.length }, error: null }));

describe("ClientsList — lifecycle row actions", () => {
  it("live row: edit + archive; delete only with canPermanentlyDelete", async () => {
    vi.stubGlobal("fetch", listResponseWith([CLIENT_ROW]));
    const admin = mountList(principalWith(true));
    await flushPromises();
    const adminKeys = (admin.findComponent(RowActionMenu).props("actions") as RowAction[]).map((a) => a.key);
    expect(adminKeys).toEqual(["edit", "archive", "delete"]);

    const member = mountList(principalWith(false));
    await flushPromises();
    const memberKeys = (member.findComponent(RowActionMenu).props("actions") as RowAction[]).map((a) => a.key);
    expect(memberKeys).toEqual(["edit", "archive"]);
  });

  it("archived row: restore action and the Archived chip", async () => {
    vi.stubGlobal("fetch", listResponseWith([{ ...CLIENT_ROW, archivedAt: "2026-01-01T00:00:00.000Z" }]));
    const wrapper = mountList(principalWith(false));
    await flushPromises();
    const keys = (wrapper.findComponent(RowActionMenu).props("actions") as RowAction[]).map((a) => a.key);
    expect(keys).toEqual(["restore"]);
    expect(wrapper.text()).toContain("Archived");
  });

  it("the show-archived switch widens the list query to archived=all", async () => {
    const fetchMock = listResponseWith([]);
    vi.stubGlobal("fetch", fetchMock);
    const lastUrl = (): string => String((fetchMock.mock.calls.at(-1) as unknown[] | undefined)?.[0]);
    const wrapper = mountList(principalWith(false));
    await flushPromises();
    expect(lastUrl()).not.toContain("archived=");

    await wrapper.find("input[type=checkbox]").setValue(true);
    await flushPromises();
    expect(lastUrl()).toContain("archived=all");
  });
});
