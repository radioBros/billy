import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import { createI18n } from "vue-i18n";
import en from "@/locales/en.json";
import StatusChip from "@/components/StatusChip.vue";

const vuetify = createVuetify({ components, directives });
// StatusChip now uses useI18n(); build a real en catalog so labels resolve and
// the missing-key fallback path is exercised for unknown codes.
const i18n = createI18n({ legacy: false, locale: "en", fallbackLocale: "en", messages: { en } });

const mountChip = (status?: string | null) => {
  return mount(StatusChip, {
    props: { status },
    global: { plugins: [vuetify, i18n] },
  });
};

describe("StatusChip", () => {
  it("maps scheduled to the warning colour role", () => {
    const wrapper = mountChip("scheduled");
    // color prop reaches the v-chip as the `text-warning`/`bg-warning` class family.
    expect(wrapper.html()).toContain("warning");
  });

  it("renders the translated enum label for a known status", () => {
    // The label carries the meaning (A7) and comes from enums.status.* now.
    expect(mountChip("scheduled").text()).toBe("Scheduled");
    expect(mountChip("partially_paid").text()).toBe("Partially paid");
  });

  it("falls back to a humanized code when the status has no translation", () => {
    // vue-i18n returns the key on a miss → StatusChip humanizes the raw code.
    expect(mountChip("bogus_code").text()).toBe("Bogus Code");
  });

  it("distinguishes scheduled from draft (a distinct colour role)", () => {
    const scheduled = mountChip("scheduled").html();
    const draft = mountChip("draft").html();
    expect(scheduled).toContain("warning");
    expect(draft).toContain("surface-variant");
    expect(scheduled).not.toContain("surface-variant");
  });

  it("falls back to a neutral chip for unknown/empty statuses", () => {
    expect(mountChip(null).text()).toBe("—");
    expect(mountChip("bogus").html()).toContain("surface-variant");
  });
});
