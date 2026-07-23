import { describe, it, expect, beforeAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import ColorInput from "@/components/ColorInput.vue";

const vuetify = createVuetify({ components, directives });

const makeHost = (initial: string) => {
  const model = ref(initial);
  const Host = defineComponent({
    setup() {
      return () =>
        h(ColorInput, {
          modelValue: model.value,
          label: "Primary color",
          "onUpdate:modelValue": (v: string) => {
            model.value = v;
          },
        });
    },
  });
  const wrapper = mount(Host, { global: { plugins: [vuetify] } });
  return { wrapper, model };
};

beforeAll(() => {
  setActivePinia(createPinia());
  if (!("ResizeObserver" in globalThis)) {
    class RO {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  }
});

describe("ColorInput", () => {
  it("renders the swatch activator", () => {
    const { wrapper } = makeHost("#5b5bd6");
    expect(wrapper.find(".color-input__swatch").exists()).toBe(true);
  });

  it("normalizes a typed hex to #rrggbb (leading #, lowercase) on blur", async () => {
    const { wrapper, model } = makeHost("#000000");
    const input = wrapper.find("input");
    await input.setValue("5B5BD6"); // no #, uppercase
    await input.trigger("blur");
    await flushPromises();
    expect(model.value).toBe("#5b5bd6");
  });

  it("strips 8-digit alpha and expands 3-digit shorthand on blur", async () => {
    const { wrapper, model } = makeHost("#000000");
    const input = wrapper.find("input");

    await input.setValue("#abc");
    await input.trigger("blur");
    await flushPromises();
    expect(model.value).toBe("#aabbcc");

    await input.setValue("#11223344");
    await input.trigger("blur");
    await flushPromises();
    expect(model.value).toBe("#112233");
  });
});
