import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useLocaleStore } from "@/stores/locale";
import { i18n } from "@/plugins/i18n";

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  i18n.global.locale.value = "en";
});

afterEach(() => {
  localStorage.clear();
});

describe("locale store", () => {
  it("setLocale changes the vue-i18n locale and persists the choice", () => {
    const store = useLocaleStore();
    expect(store.current).toBe("en");

    store.setLocale("es");

    expect(store.current).toBe("es");
    expect(store.explicit).toBe(true);
    expect(i18n.global.locale.value).toBe("es");
    expect(localStorage.getItem("billy.locale")).toBe("es");
  });

  it("seedFromDefault normalizes a settings locale (en-US → en) when not explicit", () => {
    const store = useLocaleStore();
    store.seedFromDefault("es-ES");
    expect(store.current).toBe("es");
    expect(i18n.global.locale.value).toBe("es");
  });

  it("seedFromDefault is a no-op once the user has chosen explicitly", () => {
    const store = useLocaleStore();
    store.setLocale("en");
    store.seedFromDefault("es-ES");
    expect(store.current).toBe("en");
  });

  it("seedFromDefault normalizes a newly supported locale (fr-FR → fr)", () => {
    const store = useLocaleStore();
    store.seedFromDefault("fr-FR");
    expect(store.current).toBe("fr");
    expect(i18n.global.locale.value).toBe("fr");
  });

  it("falls back to the default for an unsupported locale", () => {
    const store = useLocaleStore();
    store.seedFromDefault("ja-JP");
    expect(store.current).toBe("en");
  });
});
