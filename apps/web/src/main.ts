/**
 * App entry. Wires Vue + Vuetify (light+dark themes) + Pinia + Router.
 * Runtime config (config.js) has already been loaded by index.html before this
 * bundle, so getConfig()/apiBaseUrl() are safe to read from here on.
 */
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "@/App.vue";
import { router } from "@/router";
import { vuetify } from "@/plugins/vuetify";
import { i18n } from "@/plugins/i18n";
import { onUnauthenticated } from "@/api/client";
import { useAuthStore } from "@/stores/auth";
import { useThemeStore } from "@/stores/theme";
import { useBrandingStore } from "@/stores/branding";
import { useLocaleStore } from "@/stores/locale";
// Global UI polish (gradients, transitions, reduced-motion overrides). Imported
// last so it cascades over Vuetify's base styles (which the vuetify plugin loads).
import "@/styles/app.scss";

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(vuetify);
app.use(i18n);
app.use(router);

// Auto-logout on session expiry: any request that comes back UNAUTHENTICATED
// (401) clears the principal and bounces to /login (preserving the intended path
// as `redirect`), instead of surfacing a raw "UNAUTHENTICATED" error on the page.
// Guarded against loops when already on /login. Registered here (post-pinia/router).
const authStore = useAuthStore();
onUnauthenticated(() => {
  authStore.clearSession();
  const current = router.currentRoute.value;
  if (current.name === "login") return;
  void router.replace({ name: "login", query: { redirect: current.fullPath } });
});

// Apply the persisted theme and start watching the OS preference.
const themeStore = useThemeStore();
themeStore.watchSystem();
vuetify.theme.change(themeStore.vuetifyTheme);

// Apply the persisted locale (or default) before mount so the shell renders in
// the right language. The branding store later seeds the default locale for
// first-time users (no stored choice) once localization settings resolve.
const localeStore = useLocaleStore();
localeStore.apply();

// Runtime branding: apply cached/default colors + name synchronously to
// avoid a flash, then fetch fresh branding once the router (and thus the session)
// has resolved. `load` never throws, so a member/offline boot keeps defaults.
const brandingStore = useBrandingStore();
brandingStore.applyCached(vuetify.theme);
void router.isReady().then(async () => {
  await brandingStore.load(vuetify.theme);
  // Seed the default locale from localization settings for first-time users (no
  // stored choice). Never blocks/crashes: an unauthenticated or errored fetch
  // simply leaves the default/stored locale in place.
  if (!localeStore.explicit) {
    try {
      const { get } = await import("@/api/client");
      const loc = await get<{ defaultLocale?: string }>("/v1/settings/localization");
      localeStore.seedFromDefault(loc.defaultLocale);
    } catch {
      /* keep default/stored locale */
    }
  }
});

app.mount("#app");
