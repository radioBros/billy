import { describe, it, expect, beforeAll } from "vitest";
import { mount } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import LineItemEditor from "@/components/LineItemEditor.vue";
import type { LineItemInput } from "@/types/domain";

// Local Vuetify instance built WITHOUT the app's plugin file, whose `vuetify/styles`
// + mdi-font CSS imports vitest's ESM loader cannot resolve. Components + directives
// are enough to mount the editor.
const vuetify = createVuetify({ components, directives });

beforeAll(() => {
  // Vuetify components reference ResizeObserver, absent in jsdom.
  if (!("ResizeObserver" in globalThis)) {
    class RO {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  }
});

const mountEditor = (modelValue: LineItemInput[]) => {
  return mount(LineItemEditor, {
    props: { modelValue, currency: "EUR" },
    global: { plugins: [vuetify] },
  });
};

describe("LineItemEditor", () => {
  it("renders one row per line item and shows the document total", () => {
    const wrapper = mountEditor([
      { description: "Design", quantity: 2, unitPriceMinor: 1000, taxRate: 10 },
    ]);
    // 2 × €10.00 = €20.00 subtotal, +10% tax = €22.00 total.
    expect(wrapper.text()).toMatch(/22[.,]00/u);
    expect(wrapper.findAll("tbody tr")).toHaveLength(1);
  });

  it("emits raw line inputs (minor units) without any computed *Minor totals", async () => {
    const wrapper = mountEditor([{ description: "A", quantity: 1, unitPriceMinor: 500 }]);
    const addBtn = wrapper.findAll("button").find((b) => b.text().includes("Add line"));
    expect(addBtn).toBeTruthy();
    await addBtn!.trigger("click");

    const events = wrapper.emitted("update:modelValue");
    expect(events).toBeTruthy();
    const lastEvent = events?.[events.length - 1];
    expect(lastEvent).toBeTruthy();
    const last = lastEvent![0] as Record<string, unknown>[];
    expect(last).toHaveLength(2);
    for (const line of last) {
      expect(line).toHaveProperty("description");
      expect(line).toHaveProperty("quantity");
      expect(line).toHaveProperty("unitPriceMinor");
      expect(line).not.toHaveProperty("lineSubtotalMinor");
      expect(line).not.toHaveProperty("lineTotalMinor");
    }
  });
});
