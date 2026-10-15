import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { computed } from "vue";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import DocumentActions from "@/components/DocumentActions.vue";
import en from "@/locales/en.json";
import { polyfillBrowser } from "@/test/helpers/einvoicing";

// Phone layout (< 600px): jsdom has no real viewport, so force the breakpoint.
vi.mock("@/composables/useIsMobile", () => ({ useIsMobile: () => computed(() => true) }));

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

beforeAll(polyfillBrowser);
beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("DocumentActions — phone layout", () => {
  it("renders three labelled tiles and opens a fullscreen fit-to-width preview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: { html: "<h1>Hi</h1>" }, meta: {}, error: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const wrapper = mount(DocumentActions, {
      props: { documentType: "invoice", documentId: "inv_1" },
      attachTo: document.body,
      global: { plugins: [vuetify, i18n] },
    });
    const tiles = wrapper.findAll(".doc-actions__tile");
    expect(tiles.map((b) => b.attributes("aria-label"))).toEqual(["Preview", "Print", "Download"]);

    await wrapper.find('[data-test="doc-action-preview"]').trigger("click");
    await flushPromises();
    expect(document.body.querySelector(".v-dialog--fullscreen")).not.toBeNull();
    const iframe = document.body.querySelector<HTMLIFrameElement>(".doc-actions__fit-iframe");
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute("srcdoc")).toContain("<h1>Hi</h1>");
    // Laid out at the A4 width, scaled by transform.
    expect(iframe!.style.width).toBe("794px");
    wrapper.unmount();
  });
});
