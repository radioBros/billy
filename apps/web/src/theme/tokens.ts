/**
 * Design tokens → Vuetify theme definitions.
 *
 * Both light and dark themes are mandatory. Semantic roles map to
 * Vuetify theme keys; the `--billy-*` neutral text ramp is mirrored as
 * custom CSS variables so the provided scoped-CSS components resolve. Aesthetic:
 * Linear/Notion/Stripe clarity — no hard-coded hex in components.
 */
import type { ThemeDefinition } from "vuetify";

export const lightTheme: ThemeDefinition = {
  dark: false,
  colors: {
    primary: "#5b5bd6",
    secondary: "#6b7280",
    surface: "#ffffff",
    background: "#f8f9fb",
    success: "#16a34a",
    warning: "#d97706",
    error: "#dc2626",
    info: "#2563eb",
    "on-primary": "#ffffff",
    "on-surface": "#111827",
    "on-background": "#111827",
  },
  variables: {
    "billy-text-1": "rgba(0,0,0,.87)",
    "billy-text-2": "rgba(0,0,0,.60)",
    "billy-text-3": "rgba(0,0,0,.38)",
    "billy-border": "rgba(0,0,0,.12)",
    "background-2": "rgb(241, 241, 241)"
  },
};

export const darkTheme: ThemeDefinition = {
  dark: true,
  colors: {
    primary: "#8b8bf0",
    secondary: "#9ca3af",
    surface: "#1c1c1f",
    background: "#131316",
    success: "#22c55e",
    warning: "#f59e0b",
    error: "#ef4444",
    info: "#3b82f6",
    "on-primary": "#0b0b0f",
    "on-surface": "#f3f4f6",
    "on-background": "#f3f4f6",
  },
  variables: {
    "billy-text-1": "rgba(255,255,255,.92)",
    "billy-text-2": "rgba(255,255,255,.70)",
    "billy-text-3": "rgba(255,255,255,.50)",
    "billy-border": "rgba(255,255,255,.16)",
    "background-2": "rgb(45,45,45)"
  },
};

export const LIGHT = "billyLight";
export const DARK = "billyDark";
