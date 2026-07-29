/**
 * Vuetify 3 plugin. Manual wiring — `vite-plugin-vuetify` is not a
 * dependency, so components/directives are imported explicitly. Themes come from
 * the design tokens; both light+dark are registered.
 */
import "vuetify/styles";
import "@mdi/font/css/materialdesignicons.css";
import { createVuetify } from "vuetify";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import { aliases, mdi } from "vuetify/iconsets/mdi";
import { lightTheme, darkTheme, LIGHT, DARK } from "@/theme/tokens";

export const vuetify = createVuetify({
  components,
  directives,
  icons: {
    defaultSet: "mdi",
    aliases,
    sets: { mdi },
  },
  theme: {
    defaultTheme: LIGHT,
    themes: {
      [LIGHT]: lightTheme,
      [DARK]: darkTheme,
    },
  },
  defaults: {
    global: {
      // Linear/Notion/Stripe density.
      density: "comfortable",
    },
    VBtn: {
      rounded: 'xl',
      flat: true,
      density: 'default',
      class: 'px-5',
      variant: 'tonal',
      style: 'text-transform: none; letter-spacing: -0.01em; font-weight: 600;',
    },
    // VCardActions injects its OWN `VBtn: { variant: 'text' }` default, which is
    // nearer than the global one and so wins — making action-row buttons render
    // as text even when they set no variant. Re-assert `tonal` for buttons inside
    // card actions so dialog/card action buttons match the app-wide tonal style.
    VCardActions: {
      VBtn: {
        variant: 'tonal',
      },
    },
    // All inputs get a filled surface (white in light, dark surface in dark) so
    // fields read as solid controls against the tinted page background rather
    // than transparent outlines. `bgColor: 'surface'` paints the field interior.
    VTextField: {
      variant: 'outlined',
      density: 'comfortable',
      rounded: 'lg',
      bgColor: 'surface',
    },
    VTextarea: {
      variant: 'outlined',
      density: 'comfortable',
      rounded: 'lg',
      bgColor: 'surface',
    },
    VSelect: {
      variant: 'outlined',
      density: 'comfortable',
      rounded: 'lg',
      bgColor: 'surface',
    },
    VAutocomplete: {
      variant: 'outlined',
      density: 'comfortable',
      rounded: 'lg',
      bgColor: 'surface',
    },
    VCombobox: {
      variant: 'outlined',
      density: 'comfortable',
      rounded: 'lg',
      bgColor: 'surface',
    },
    VCard: {
      rounded: 'lg',
      // Do NOT set `color` here: a global `color:'surface'` flips text to the
      // contrasting on-color and, combined with tonal/variant cards, produced
      // transparent cards with white/unreadable text. The solid surface bg +
      // correct text color are enforced in styles/app.css `.v-card` instead,
      // which applies uniformly without fighting Vuetify's variant logic.
    },
    VChip: {
      rounded: 'pill',
    },
    VAlert: {
      rounded: 'lg',
    },
    VSwitch: {
      inset: true,
    },
    VDataTable: {
      fixedHeader: true,
    },
    // Tab content transitions: a simple fade, never a horizontal slide.
    // VTabsWindow (tab bodies) + VWindow (its base) both take a `transition`.
    VTabsWindow: {
      transition: 'fade-transition',
      reverseTransition: 'fade-transition',
    },
    VWindow: {
      transition: 'fade-transition',
      reverseTransition: 'fade-transition',
    },
    VDialog: {
      transition: 'dialog-bottom-transition',
      closeOnBack: false,
      noClickAnimation: true,
      persistent: true, // never close on click-outside or Escape
    }
  },
});
