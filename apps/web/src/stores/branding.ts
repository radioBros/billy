/**
 * Branding store. Runtime white-labelling: on boot we apply the last
 * cached branding synchronously (anti-flash), then fetch `/v1/settings/branding`
 * and re-apply. Colors flow into the running Vuetify theme (no rebuild), and the
 * app name / logo feed the shell. Any fetch error falls back to cache → defaults,
 * so a non-admin (or offline) user is never left with a broken shell.
 *
 * The theme-mutation is DI'd (the ThemeInstance is passed in) so it stays free of
 * the `@/plugins/vuetify` CSS imports vitest cannot resolve — main.ts and the
 * Branding live-preview pass the real instance; tests pass a bare createVuetify.
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import type { ThemeInstance } from "vuetify";
import { api, ApiError } from "@/api/client";
import type { BrandingSettings } from "@/types/domain";
import { logoUrlFor } from "@/api/files";
import { LIGHT, DARK, lightTheme, darkTheme } from "@/theme/tokens";

const STORAGE_KEY = "billy.branding";

/** Fallback favicon (the bundled Billy default) when no custom icon is set. */
const DEFAULT_FAVICON_HREF = "/favicon.png";

/** The subset of branding applied to the running theme + shell. */
export interface AppliedBranding {
  appName: string;
  logoFileId: string | null;
  /** App ICON — also the browser favicon. Null → bundled Billy default. */
  faviconFileId: string | null;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
}

export const DEFAULT_BRANDING: AppliedBranding = {
  appName: "Billy",
  logoFileId: null,
  faviconFileId: null,
  primaryColor: lightTheme.colors?.primary ?? "#5b5bd6",
  secondaryColor: lightTheme.colors?.secondary ?? "#6b7280",
  accentColor: darkTheme.colors?.primary ?? "#8b8bf0",
};

export const applyFavicon = (faviconFileId: string | null): void => {
  if (typeof document === "undefined") return;
  const href = faviconFileId ? logoUrlFor(faviconFileId) : DEFAULT_FAVICON_HREF;
  for (const rel of ["icon", "apple-touch-icon"]) {
    let link = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
    if (!link) {
      link = document.createElement("link");
      link.rel = rel;
      document.head.appendChild(link);
    }
    link.href = href;
  }
};

function isHexColor(v: unknown): v is string {
  return typeof v === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/u.test(v);
}

export const normalizeHex = (v: string): string => {
  if (/^#[0-9a-fA-F]{8}$/u.test(v)) return v.slice(0, 7);
  return v;
};

const readCache = (): AppliedBranding | null => {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AppliedBranding>;
    return {
      appName: typeof parsed.appName === "string" ? parsed.appName : DEFAULT_BRANDING.appName,
      logoFileId: typeof parsed.logoFileId === "string" ? parsed.logoFileId : null,
      faviconFileId: typeof parsed.faviconFileId === "string" ? parsed.faviconFileId : null,
      primaryColor: isHexColor(parsed.primaryColor) ? parsed.primaryColor : DEFAULT_BRANDING.primaryColor,
      secondaryColor: isHexColor(parsed.secondaryColor)
        ? parsed.secondaryColor
        : DEFAULT_BRANDING.secondaryColor,
      accentColor: isHexColor(parsed.accentColor) ? parsed.accentColor : DEFAULT_BRANDING.accentColor,
    };
  } catch {
    return null;
  }
};

const writeCache = (b: AppliedBranding): void => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(b));
  } catch {
    /* quota / private-mode: cache is best-effort */
  }
};

export const toApplied = (b: BrandingSettings): AppliedBranding => {
  return {
    appName: b.appName || DEFAULT_BRANDING.appName,
    logoFileId: b.logoFileId,
    faviconFileId: b.faviconFileId,
    primaryColor: isHexColor(b.primaryColor) ? b.primaryColor : DEFAULT_BRANDING.primaryColor,
    secondaryColor: isHexColor(b.secondaryColor) ? b.secondaryColor : DEFAULT_BRANDING.secondaryColor,
    accentColor: isHexColor(b.accentColor) ? b.accentColor : DEFAULT_BRANDING.accentColor,
  };
};

export const applyThemeColors = (theme: ThemeInstance, colors: Pick<AppliedBranding, "primaryColor" | "secondaryColor" | "accentColor">): void => {
  const themes = theme.themes.value;
  const light = themes[LIGHT];
  const dark = themes[DARK];
  if (light) {
    light.colors = {
      ...light.colors,
      primary: colors.primaryColor,
      secondary: colors.secondaryColor,
      accent: colors.accentColor,
    };
  }
  if (dark) {
    dark.colors = {
      ...dark.colors,
      primary: colors.primaryColor,
      secondary: colors.secondaryColor,
      accent: colors.accentColor,
    };
  }
};

export const useBrandingStore = defineStore("branding", () => {
  const appName = ref<string>(DEFAULT_BRANDING.appName);
  const logoFileId = ref<string | null>(DEFAULT_BRANDING.logoFileId);
  const faviconFileId = ref<string | null>(DEFAULT_BRANDING.faviconFileId);
  const primaryColor = ref<string>(DEFAULT_BRANDING.primaryColor);
  const secondaryColor = ref<string>(DEFAULT_BRANDING.secondaryColor);
  const accentColor = ref<string>(DEFAULT_BRANDING.accentColor);
  const loaded = ref<boolean>(false);

  /** Apply an AppliedBranding to state + the theme instance (no fetch, no cache). */
  function apply(theme: ThemeInstance, b: AppliedBranding): void {
    appName.value = b.appName;
    logoFileId.value = b.logoFileId;
    faviconFileId.value = b.faviconFileId;
    primaryColor.value = b.primaryColor;
    secondaryColor.value = b.secondaryColor;
    accentColor.value = b.accentColor;
    applyThemeColors(theme, b);
    applyFavicon(b.faviconFileId);
  }

  /** Apply the cached (or default) branding immediately — call before mount. */
  function applyCached(theme: ThemeInstance): void {
    apply(theme, readCache() ?? DEFAULT_BRANDING);
  }

  /**
   * Fetch fresh branding and apply it. Never throws: on any error the current
   * (cached/default) branding stays in place. Members lacking canManageSettings
   * simply keep defaults if the endpoint denies them.
   */
  async function load(theme: ThemeInstance): Promise<void> {
    try {
      const b = await api.get<BrandingSettings>("/v1/settings/branding");
      const applied = toApplied(b);
      apply(theme, applied);
      writeCache(applied);
    } catch (err) {
      // Swallow: keep cached/default branding. Surface nothing to the user — the
      // shell must still render for members / offline / pre-config states.
      if (!(err instanceof ApiError)) throw err;
    } finally {
      loaded.value = true;
    }
  }

  return {
    appName,
    logoFileId,
    faviconFileId,
    primaryColor,
    secondaryColor,
    accentColor,
    loaded,
    apply,
    applyCached,
    load,
  };
});
