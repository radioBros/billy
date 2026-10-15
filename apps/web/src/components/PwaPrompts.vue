<script setup lang="ts">
/**
 * PwaPrompts — the app's PWA UX surface, mounted once in AppShell:
 *   1. INSTALL modal — when the browser offers install (beforeinstallprompt),
 *      show a dismissible card with an "Install" button (→ native prompt). The
 *      browser's address-bar install icon also works independently.
 *   2. UPDATE modal — when a new service worker is waiting (registerType:
 *      "prompt"), show "a new version is available → Reload". Reload calls
 *      updateServiceWorker(true), which posts SKIP_WAITING to the waiting SW and
 *      reloads once it activates.
 *   3. PUSH prompt — the one-time notification permission ask is driven by the
 *      bell (usePushNotifications.maybeAutoPrompt); here we only offer a gentle
 *      re-ask entry point if it's supported and still undecided.
 *
 * All of this is only live on the BUILT app with a registered service worker —
 * never the Vite dev server (SW disabled there).
 */
import { ref } from "vue";
import { useI18n } from "vue-i18n";
// Virtual module from vite-plugin-pwa; registers the SW and exposes update state.
import { useRegisterSW } from "virtual:pwa-register/vue";
import { usePwaInstall } from "@/composables/usePwaInstall";

const { t } = useI18n();

// ── Update (prompt mode) ─────────────────────────────────────────────────────
const { needRefresh, updateServiceWorker } = useRegisterSW({
  onRegisteredSW(_swUrl, registration) {
    // Poll for a new SW hourly so long-lived tabs still learn about updates.
    if (registration) {
      setInterval(() => void registration.update(), 60 * 60 * 1000);
    }
  },
});
const reloading = ref(false);
/** Fallback reload delay when no controller change is observed. */
const UPDATE_RELOAD_FALLBACK_MS = 4000;
const applyUpdate = async (): Promise<void> => {
  reloading.value = true;
  // The plugin only reloads on Workbox's `controlling` event with isUpdate=true,
  // which never fires for a page that was NOT controlled at load (e.g. after a
  // hard refresh, which bypasses the SW): the new SW activates + claims the page
  // and the button spun forever. Reload ourselves on ANY controller change, and
  // as a last resort after a short timeout (the new SW is active by then).
  let done = false;
  const reload = (): void => {
    if (done) return;
    done = true;
    window.location.reload();
  };
  navigator.serviceWorker?.addEventListener("controllerchange", reload, { once: true });
  window.setTimeout(reload, UPDATE_RELOAD_FALLBACK_MS);
  try {
    await updateServiceWorker(true); // posts SKIP_WAITING to the waiting SW
  } catch {
    reload();
  }
};

// ── Install ──────────────────────────────────────────────────────────────────
const { canInstall, promptInstall } = usePwaInstall();
const installDismissed = ref(false);
const onInstall = async (): Promise<void> => {
  await promptInstall();
  installDismissed.value = true; // a prompt is single-use either way
};
</script>

<template>
  <!-- Update available (waiting SW). Persistent — a stale app is worth interrupting. -->
  <v-snackbar
    :model-value="needRefresh"
    :timeout="-1"
    location="bottom"
    color="primary"
    class="pwa-prompt"
  >
    <div class="d-flex align-center" style="gap: 8px">
      <v-icon icon="mdi-update" />
      <span>{{ t("pwa.update.message") }}</span>
    </div>
    <template #actions>
      <!-- The snackbar itself is primary-blue: the action must be a contrasting
           filled button (a primary-colored button would vanish into it). -->
      <v-btn color="white" variant="flat" :loading="reloading" @click="applyUpdate">
        {{ t("pwa.update.reload") }}
      </v-btn>
    </template>
  </v-snackbar>

  <!-- Install offer (only when the browser is willing + not dismissed this session). -->
  <v-snackbar
    :model-value="canInstall && !installDismissed"
    :timeout="-1"
    location="bottom start"
    class="pwa-prompt"
  >
    <div class="d-flex align-center" style="gap: 8px">
      <v-icon icon="mdi-download-circle-outline" />
      <span>{{ t("pwa.install.message") }}</span>
    </div>
    <template #actions>
      <v-btn variant="text" @click="installDismissed = true">{{ t("common.dismiss") }}</v-btn>
      <v-btn color="primary" @click="onInstall">{{ t("pwa.install.action") }}</v-btn>
    </template>
  </v-snackbar>
</template>
