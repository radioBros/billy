import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref } from "vue";
import { createReusableTemplate } from "@/composables/useReusableTemplate";

describe("createReusableTemplate", () => {
  it("renders the defined content wherever Reuse is placed, and stays reactive", async () => {
    const count = ref(1);
    const Host = defineComponent({
      setup() {
        const { Define, Reuse } = createReusableTemplate();
        return () =>
          h("div", [
            h(Define, null, { default: () => h("span", { class: "chunk" }, `n=${count.value}`) }),
            h("section", { class: "a" }, [h(Reuse)]),
            h("section", { class: "b" }, [h(Reuse)]),
          ]);
      },
    });
    const wrapper = mount(Host);
    await nextTick();
    expect(wrapper.find(".a .chunk").text()).toBe("n=1");
    expect(wrapper.find(".b .chunk").text()).toBe("n=1");
    // Define itself renders nothing.
    expect(wrapper.findAll(".chunk")).toHaveLength(2);

    count.value = 2;
    await nextTick();
    expect(wrapper.find(".a .chunk").text()).toBe("n=2");
    expect(wrapper.find(".b .chunk").text()).toBe("n=2");
  });

  it("keeps separate instances independent", async () => {
    const Host = defineComponent({
      setup() {
        const one = createReusableTemplate();
        const two = createReusableTemplate();
        return () =>
          h("div", [
            h(one.Define, null, { default: () => h("i", "one") }),
            h(two.Define, null, { default: () => h("b", "two") }),
            h(two.Reuse),
            h(one.Reuse),
          ]);
      },
    });
    const wrapper = mount(Host);
    await nextTick();
    expect(wrapper.text()).toBe("twoone");
  });
});
