import { describe, it, expect, vi, beforeAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import AttachmentsField, { type Attachment } from "@/components/AttachmentsField.vue";
import en from "@/locales/en.json";

vi.mock("@/api/files", () => ({
  uploadFile: vi.fn(async () => "stub-file-id"),
  logoUrlFor: (id: string) => `http://api.test/api/v1/files/${id}/content`,
}));

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

const makeHost = (initial: Attachment[]) => {
  const model = ref<Attachment[]>(initial);
  const Host = defineComponent({
    setup() {
      return () =>
        h(AttachmentsField, {
          modelValue: model.value,
          "onUpdate:modelValue": (v: Attachment[]) => {
            model.value = v;
          },
        });
    },
  });
  const wrapper = mount(Host, { global: { plugins: [vuetify, i18n] } });
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

const seeded: Attachment[] = [
  { fileId: "a1", filename: "photo.png", sizeBytes: 2048, contentType: "image/png" },
  { fileId: "b2", filename: "invoice.pdf", sizeBytes: 4096, contentType: "application/pdf" },
];

describe("AttachmentsField", () => {
  it("renders the add button with an empty model", () => {
    const { wrapper } = makeHost([]);
    expect(wrapper.text()).toContain("Add files");
    expect(wrapper.find(".attachments-field__zone").exists()).toBe(true);
  });

  it("renders one row per seeded attachment", () => {
    const { wrapper } = makeHost([...seeded]);
    const rows = wrapper.findAll(".attachments-field__row");
    expect(rows).toHaveLength(2);
    expect(wrapper.text()).toContain("photo.png");
    expect(wrapper.text()).toContain("invoice.pdf");
  });

  it("emits an updated model with the item removed", async () => {
    const { wrapper, model } = makeHost([...seeded]);
    const removeBtns = wrapper
      .findAll("button")
      .filter((b) => b.attributes("aria-label") === "Remove");
    expect(removeBtns.length).toBe(2);
    await removeBtns[0]!.trigger("click");
    await flushPromises();
    expect(model.value).toHaveLength(1);
    expect(model.value[0]!.fileId).toBe("b2");
  });
});
