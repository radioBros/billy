import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { createVuetify } from "vuetify";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import { useBrandingStore, applyThemeColors, toApplied } from "@/stores/branding";
import { LIGHT, DARK, lightTheme, darkTheme } from "@/theme/tokens";
import type { BrandingSettings } from "@/types/domain";

// Bare Vuetify (no @/plugins/vuetify → no CSS imports vitest can't resolve),
// with the app's two named themes registered so color mutation has a target.
const makeTheme = () => {
  const vuetify = createVuetify({
    components,
    directives,
    theme: { defaultTheme: LIGHT, themes: { [LIGHT]: lightTheme, [DARK]: darkTheme } },
  });
  return vuetify.theme;
};

const colorsOf = (theme: ReturnType<typeof makeTheme>, name: string): Record<string, string> => {
  const t = theme.themes.value[name];
  if (!t) throw new Error(`theme ${name} not registered`);
  return t.colors;
};

const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

const FULL: BrandingSettings = {
  appName: "Acme Corp",
  logoFileId: "file_123",
  faviconFileId: null,
  primaryColor: "#ff0000",
  secondaryColor: "#00ff00",
  accentColor: "#0000ff",
  defaultThemeMode: "system",
  loginBackground: null,
  supportEmail: "help@acme.test",
  documentHeaderHtml: null,
  documentFooterHtml: null,
};

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("applyThemeColors (pure)", () => {
  it("pushes brand colors into BOTH light and dark themes", () => {
    const theme = makeTheme();
    applyThemeColors(theme, {
      primaryColor: "#ff0000",
      secondaryColor: "#00ff00",
      accentColor: "#0000ff",
    });
    expect(colorsOf(theme, LIGHT).primary).toBe("#ff0000");
    expect(colorsOf(theme, LIGHT).secondary).toBe("#00ff00");
    expect(colorsOf(theme, LIGHT).accent).toBe("#0000ff");
    expect(colorsOf(theme, DARK).primary).toBe("#ff0000");
    expect(colorsOf(theme, DARK).accent).toBe("#0000ff");
  });
});

describe("branding store — load applies colors to the theme", () => {
  it("fetches /v1/settings/branding and applies colors + name + logo", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: FULL, meta: {}, error: null }));
    vi.stubGlobal("fetch", fetchMock);

    const theme = makeTheme();
    const store = useBrandingStore();
    await store.load(theme);

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("/v1/settings/branding");

    expect(store.appName).toBe("Acme Corp");
    expect(store.logoFileId).toBe("file_123");
    expect(store.primaryColor).toBe("#ff0000");
    expect(colorsOf(theme, LIGHT).primary).toBe("#ff0000");
    expect(colorsOf(theme, DARK).secondary).toBe("#00ff00");
    expect(store.loaded).toBe(true);
    // Cached for anti-flash re-apply on next boot.
    expect(localStorage.getItem("billy.branding")).toContain("Acme Corp");
  });

  it("falls back to defaults (never throws) when the endpoint denies/fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ data: null, meta: {}, error: { code: "CAPABILITY_DENIED", message: "no" } }, 403),
      ),
    );
    const theme = makeTheme();
    const store = useBrandingStore();
    await expect(store.load(theme)).resolves.toBeUndefined();
    expect(store.appName).toBe("Billy");
    expect(store.loaded).toBe(true);
  });

  it("applyCached applies cached branding synchronously without a fetch", () => {
    localStorage.setItem(
      "billy.branding",
      JSON.stringify(toApplied(FULL)),
    );
    const theme = makeTheme();
    const store = useBrandingStore();
    store.applyCached(theme);
    expect(store.appName).toBe("Acme Corp");
    expect(colorsOf(theme, LIGHT).primary).toBe("#ff0000");
  });
});
