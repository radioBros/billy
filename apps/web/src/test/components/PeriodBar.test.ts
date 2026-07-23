import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createVuetify } from "vuetify";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import { i18n } from "@/plugins/i18n";
import PeriodBar from "@/components/PeriodBar.vue";
import * as apiClient from "@/api/client";

const vuetify = createVuetify({ components, directives });

// Twelve months; a couple carry counts + € totals, the rest are zero.
const TOTALS = Array.from({ length: 12 }, (_, i) => ({
  month: `2026-${String(i + 1).padStart(2, "0")}`,
  monthNumber: i + 1,
  count: i === 0 ? 3 : i === 5 ? 5 : 0,
  totals: i === 0 ? { EUR: 420000 } : i === 5 ? { EUR: 108800 } : {},
}));

const mockGet = (): void => {
  vi.spyOn(apiClient.api, "get").mockImplementation((path: string) => {
    if (path.includes("/years")) return Promise.resolve({ minYear: 2024, maxYear: 2026 });
    if (path.includes("monthly-totals")) return Promise.resolve(TOTALS);
    return Promise.resolve([]);
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
  setActivePinia(createPinia());
  i18n.global.locale.value = "en";
  mockGet();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const mountBar = (props: Record<string, unknown> = {}) =>
  mount(PeriodBar, {
    props: { kind: "invoices", ...props },
    global: { plugins: [createPinia(), vuetify, i18n] },
  });

describe("PeriodBar", () => {
  it("fetches monthly-totals for the kind and renders 12 month cells + 'All year'", async () => {
    const wrapper = mountBar();
    await flushPromises();

    const getSpy = apiClient.api.get as unknown as ReturnType<typeof vi.fn>;
    // It requested the totals for the invoices kind.
    expect(
      getSpy.mock.calls.some(
        (c: unknown[]) =>
          String(c[0]).includes("monthly-totals") &&
          (c[1] as { kind?: string })?.kind === "invoices",
      ),
    ).toBe(true);

    // 12 month cells + the leading "All year" cell = 13 buttons.
    const cells = wrapper.findAll("button.period-cell");
    expect(cells).toHaveLength(13);

    const text = wrapper.text();
    expect(text).toContain("All year");
    // Money is rendered in cells that have totals.
    expect(text).toContain("3 docs");
    expect(text).toContain("5 docs");
  });

  it("selecting a month updates v-model:months and clearing returns to all-year", async () => {
    const wrapper = mountBar();
    await flushPromises();

    // Cells: index 0..11 = Jan..Dec, index 12 = "All year" (rightmost).
    const cells = wrapper.findAll("button.period-cell");
    // A press+release on one cell is a single toggle.
    await cells[5]!.trigger("pointerdown"); // June (monthNumber 6, index 5)
    window.dispatchEvent(new Event("pointerup"));
    await flushPromises();

    // Unbound defineModel surfaces updates as `update:months` events.
    const emitted = wrapper.emitted("update:months");
    expect(emitted).toBeTruthy();
    expect(emitted!.at(-1)).toEqual([[6]]);

    // Click "All year" (last cell) → clears the selection back to [].
    await cells[12]!.trigger("click");
    await flushPromises();
    expect(wrapper.emitted("update:months")!.at(-1)).toEqual([[]]);
  });

  it("click-drag paints a run of months, and dragging from a selected month deselects", async () => {
    const wrapper = mountBar();
    await flushPromises();
    const cells = wrapper.findAll("button.period-cell");

    // Press on March (index 2) and drag across April, May → selects {3,4,5}.
    await cells[2]!.trigger("pointerdown");
    await cells[3]!.trigger("pointerenter");
    await cells[4]!.trigger("pointerenter");
    window.dispatchEvent(new Event("pointerup"));
    await flushPromises();
    expect(wrapper.emitted("update:months")!.at(-1)).toEqual([[3, 4, 5]]);

    // Now press on an ALREADY-selected month (April, index 3) → paint mode flips
    // to deselect; dragging over May removes both.
    await cells[3]!.trigger("pointerdown");
    await cells[4]!.trigger("pointerenter");
    window.dispatchEvent(new Event("pointerup"));
    await flushPromises();
    // April + May removed; only March remains.
    expect(wrapper.emitted("update:months")!.at(-1)).toEqual([[3]]);
  });

  it("re-fetches when the kind prop changes", async () => {
    const wrapper = mountBar();
    await flushPromises();
    const getSpy = apiClient.api.get as unknown as ReturnType<typeof vi.fn>;
    const before = getSpy.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes("monthly-totals"),
    ).length;

    await wrapper.setProps({ kind: "quotes" });
    await flushPromises();

    const after = getSpy.mock.calls.filter(
      (c: unknown[]) =>
        String(c[0]).includes("monthly-totals") && (c[1] as { kind?: string })?.kind === "quotes",
    );
    expect(after.length).toBeGreaterThanOrEqual(1);
    expect(
      getSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes("monthly-totals")).length,
    ).toBeGreaterThan(before);
  });
});
