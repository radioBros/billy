import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import { i18n } from "@/plugins/i18n";
import LineItemEditor from "@/components/LineItemEditor.vue";
import * as apiClient from "@/api/client";
import { polyfillBrowser } from "@/test/helpers/einvoicing";
import type { LineItemInput } from "@/types/domain";

const vuetify = createVuetify({ components, directives });

beforeAll(polyfillBrowser);
let pinia = createPinia();
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => vi.restoreAllMocks());

const mountEditor = async (enabled: boolean, lines: LineItemInput[], showNature = true) => {
  vi.spyOn(apiClient.api, "get").mockResolvedValue({ enabled, notSent: 0, overdue: 0, items: [] } as never);
  const w = mount(LineItemEditor, {
    props: { modelValue: lines, currency: "EUR", showNature },
    global: { plugins: [vuetify, i18n, pinia] },
  });
  await flushPromises();
  return w;
};

describe("LineItemEditor — Natura", () => {
  it("shows a Natura select only on 0% lines while e-invoicing is enabled", async () => {
    const w = await mountEditor(true, [
      { description: "A", quantity: 1, unitPriceMinor: 1000, taxRate: 0 },
      { description: "B", quantity: 1, unitPriceMinor: 1000, taxRate: 22 },
    ]);
    expect(w.findAll('[data-test="line-nature"]')).toHaveLength(1);
    expect(w.text()).toContain("VAT nature");
  });

  it("is hidden when e-invoicing is off or the host did not opt in (e.g. quotes)", async () => {
    const off = await mountEditor(false, [{ description: "A", quantity: 1, unitPriceMinor: 1000, taxRate: 0 }]);
    expect(off.find('[data-test="line-nature"]').exists()).toBe(false);

    setActivePinia((pinia = createPinia()));
    const quote = await mountEditor(true, [{ description: "A", quantity: 1, unitPriceMinor: 1000, taxRate: 0 }], false);
    expect(quote.find('[data-test="line-nature"]').exists()).toBe(false);
  });

  it("emits the chosen nature and drops it once the line is no longer 0%", async () => {
    const w = await mountEditor(true, [{ description: "A", quantity: 1, unitPriceMinor: 1000, taxRate: 0, nature: "N4" }]);
    const update = (): LineItemInput[] => w.emitted("update:modelValue")!.at(-1)![0] as LineItemInput[];
    const vm = w.vm as unknown as { updateRow: (i: number, p: Record<string, unknown>) => void };

    vm.updateRow(0, { nature: "N2.1" });
    expect(update()[0]!.nature).toBe("N2.1");

    vm.updateRow(0, { taxRate: 22 });
    expect(update()[0]).not.toHaveProperty("nature");
  });
});
