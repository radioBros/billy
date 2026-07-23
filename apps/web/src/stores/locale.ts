/**
 * Locale store. Persists the user's language choice to localStorage (mirroring
 * the theme store) and drives the vue-i18n global locale. On boot, if the user
 * has no stored choice, the app can seed from the branding `defaultLocale`
 * (GET /v1/settings/localization) via `seedFromDefault`.
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  normalizeLocale,
  setI18nLocale,
  type SupportedLocale,
} from "@/plugins/i18n";

const STORAGE_KEY = "billy.locale";

const readStored = (): SupportedLocale | null => {
  if (typeof localStorage === "undefined") return null;
  const v = localStorage.getItem(STORAGE_KEY);
  return v && (SUPPORTED_LOCALES as readonly string[]).includes(v) ? (v as SupportedLocale) : null;
};

export const useLocaleStore = defineStore("locale", () => {
  /** Whether the current locale came from an explicit user choice. */
  const explicit = ref<boolean>(readStored() !== null);
  const current = ref<SupportedLocale>(readStored() ?? DEFAULT_LOCALE);

  /** Apply `current` to vue-i18n. Call once at boot. */
  function apply(): void {
    setI18nLocale(current.value);
  }

  /** Set + persist an explicit user choice, and apply it immediately. */
  function setLocale(next: SupportedLocale): void {
    current.value = next;
    explicit.value = true;
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, next);
    setI18nLocale(next);
  }

  /**
   * Seed from the branding/localization default (e.g. "en-US"). No-op once the
   * user has made an explicit choice, so a saved preference always wins.
   */
  function seedFromDefault(rawDefault: string | null | undefined): void {
    if (explicit.value) return;
    current.value = normalizeLocale(rawDefault);
    setI18nLocale(current.value);
  }

  return { current, explicit, apply, setLocale, seedFromDefault };
});
