import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import ServerTable from "@/components/tables/ServerTable.vue";
import en from "@/locales/en.json";
import { polyfillBrowser } from "@/test/helpers/einvoicing";

// Toggle the breakpoint per test: jsdom has no real viewport.
const mobile = ref(true);
vi.mock("@/composables/useIsMobile", () => ({ useIsMobile: () => mobile }));

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

beforeAll(polyfillBrowser);
beforeEach(() => {
  setActivePinia(createPinia());
  mobile.value = true;
});
afterEach(() => {
  document.body.innerHTML = "";
});

const mountTable = (activeFilters?: number) =>
  mount(ServerTable, {
    props: {
      headers: [{ title: "Name", key: "name", sortable: true }],
      items: [],
      total: 0,
      page: 1,
      ipp: 25,
      sortBy: [],
      tableName: "badge-test",
      ...(activeFilters === undefined ? {} : { activeFilters }),
    },
    slots: { toolbar: "<div>filter</div>" },
    global: { plugins: [vuetify, i18n] },
  });

describe("ServerTable — phone active-filter badge", () => {
  it("shows the active filter count on the phone filter button", () => {
    const wrapper = mountTable(2);
    const btn = wrapper.find(".st-m__filter-btn");
    expect(btn.find('[data-test="filter-badge"]').text()).toBe("2");
    expect(btn.attributes("aria-label")).toBe("Filters & sort (2)");
  });

  it("shows no badge when no filter is active (or the prop is omitted)", () => {
    expect(mountTable(0).find('[data-test="filter-badge"]').exists()).toBe(false);
    expect(mountTable().find('[data-test="filter-badge"]').exists()).toBe(false);
  });

  it("renders nothing extra on desktop", () => {
    mobile.value = false;
    const wrapper = mountTable(3);
    expect(wrapper.find('[data-test="filter-badge"]').exists()).toBe(false);
  });
});
