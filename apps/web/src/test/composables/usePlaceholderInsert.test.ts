import { describe, it, expect, beforeAll } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";
import { createVuetify } from "vuetify";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import { usePlaceholderInsert } from "@/composables/usePlaceholderInsert";

const vuetify = createVuetify({ components, directives });

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

// A throwaway harness: a real v-textarea bound with v-model, plus the composable's
// contextmenu handler. Exposes the composable + model so the test can drive it and
// read the model back. Touches no form.
const Harness = defineComponent({
  setup() {
    const model = ref("A B");
    const { onContextMenu, menuState, insertToken } = usePlaceholderInsert();
    return { model, onContextMenu, menuState, insertToken };
  },
  render() {
    return h(components.VTextarea, {
      modelValue: this.model,
      "onUpdate:modelValue": (v: string) => {
        this.model = v;
      },
      onContextmenu: this.onContextMenu,
    });
  },
});

describe("usePlaceholderInsert", () => {
  it("inserts the token at the captured caret and syncs the v-model", async () => {
    const wrapper = mount(Harness, { global: { plugins: [vuetify] }, attachTo: document.body });
    const textarea = wrapper.find("textarea").element as HTMLTextAreaElement;

    // Seed a caret between "A" and " B" -> offset 1 (collapsed selection).
    textarea.focus();
    textarea.setSelectionRange(1, 1);

    // Fire the contextmenu on the native control: captures el + offsets (1,1).
    const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    // jsdom MouseEvent has no clientX/Y setter path we rely on; the handler reads
    // selectionStart/End from the element, which is what matters here.
    textarea.dispatchEvent(evt);

    const vm = wrapper.vm as unknown as {
      menuState: { open: boolean };
      insertToken: (t: string) => void;
      model: string;
    };
    // Menu opened because the control had a queryable caret.
    expect(vm.menuState.open).toBe(true);

    // Insert at the stored offset (1) — even though "focus has since moved".
    vm.insertToken("{{client.name}}");
    await wrapper.vm.$nextTick();

    // Native element reflects the splice at offset 1: "A" + token + " B".
    expect(textarea.value).toBe("A{{client.name}} B");

    // The v-model (through Vuetify's update:modelValue from the input event) reflects it.
    expect(vm.model).toBe("A{{client.name}} B");

    // Menu closed after insert.
    expect(vm.menuState.open).toBe(false);
    wrapper.unmount();
  });

  it("replaces the current selection with the inserted token", async () => {
    const wrapper = mount(Harness, { global: { plugins: [vuetify] }, attachTo: document.body });
    const textarea = wrapper.find("textarea").element as HTMLTextAreaElement;

    textarea.focus();
    // Select "A B" entirely (0..3).
    textarea.setSelectionRange(0, 3);
    textarea.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    const vm = wrapper.vm as unknown as { insertToken: (t: string) => void; model: string };
    vm.insertToken("{{total}}");
    await wrapper.vm.$nextTick();

    expect(textarea.value).toBe("{{total}}");
    expect(vm.model).toBe("{{total}}");
    wrapper.unmount();
  });

  it("does not open the menu on a control without a queryable caret", async () => {
    const wrapper = mount(Harness, { global: { plugins: [vuetify] }, attachTo: document.body });
    const textarea = wrapper.find("textarea").element as HTMLTextAreaElement;

    // Force selectionStart/End to null to simulate a non-text input.
    Object.defineProperty(textarea, "selectionStart", { value: null, configurable: true });
    Object.defineProperty(textarea, "selectionEnd", { value: null, configurable: true });

    const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    textarea.dispatchEvent(evt);

    const vm = wrapper.vm as unknown as { menuState: { open: boolean } };
    expect(vm.menuState.open).toBe(false);
    // Default menu not prevented (handler bailed before preventDefault).
    expect(evt.defaultPrevented).toBe(false);
    wrapper.unmount();
  });
});
