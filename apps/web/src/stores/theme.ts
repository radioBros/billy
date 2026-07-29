/**
 * Theme store. Mode ∈ {system, light, dark} per UserSettings.theme.
 * `system` follows prefers-color-scheme. Persisted to
 * localStorage for the shell; the settings module later syncs this to /me/settings.
 */
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { LIGHT, DARK } from "@/theme/tokens";

export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "billy.theme";

const readStored = (): ThemeMode => {
  if (typeof localStorage === "undefined") return "system";
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
};

const systemPrefersDark = (): boolean => {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
};

export const useThemeStore = defineStore("theme", () => {
  const mode = ref<ThemeMode>(readStored());
  const systemDark = ref<boolean>(systemPrefersDark());

  /** The concrete Vuetify theme name to apply. */
  const vuetifyTheme = computed<string>(() => {
    const dark = mode.value === "dark" || (mode.value === "system" && systemDark.value);
    return dark ? DARK : LIGHT;
  });

  function setMode(next: ThemeMode): void {
    mode.value = next;
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, next);
  }

  /** Cycle system → light → dark → system (toolbar toggle). */
  function cycle(): void {
    setMode(mode.value === "system" ? "light" : mode.value === "light" ? "dark" : "system");
  }

  /** Wire the OS media query so `system` reacts live. Call once at app boot. */
  function watchSystem(): void {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent): void => {
      systemDark.value = e.matches;
    };
    mq.addEventListener("change", handler);
  }

  return { mode, systemDark, vuetifyTheme, setMode, cycle, watchSystem };
});
