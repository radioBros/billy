/**
 * usePwaInstall — surface a real "Install app" action.
 *
 * Chrome/Edge don't pop an install dialog on their own; they fire a
 * `beforeinstallprompt` event (which we capture + defer) and otherwise only show
 * a subtle address-bar icon that's easy to miss. This composable captures that
 * event so the app can render its own visible Install button and call `.prompt()`
 * on demand. `canInstall` is true only while a deferred prompt exists (installable,
 * not yet installed, on a browser that supports it). After install (or on browsers
 * that don't fire the event — e.g. iOS Safari, which installs via Share → Add to
 * Home Screen) it stays false and the button hides.
 *
 * NOTE: the prompt only fires on the BUILT app served with a registered service
 * worker (prod/container), never on the Vite dev server (SW disabled there).
 */
import { ref, onMounted, onBeforeUnmount } from "vue";

/** Minimal shape of the non-standard beforeinstallprompt event. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// Module-level so the deferred prompt survives across component mounts (the event
// often fires once, early — before the button component exists).
const deferredPrompt = ref<BeforeInstallPromptEvent | null>(null);
const installed = ref<boolean>(false);
let wired = false;

const wireOnce = (): void => {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // stop the mini-infobar; we drive the prompt ourselves
    deferredPrompt.value = e as BeforeInstallPromptEvent;
  });
  window.addEventListener("appinstalled", () => {
    installed.value = true;
    deferredPrompt.value = null;
  });
};

export function usePwaInstall() {
  const canInstall = ref<boolean>(false);

  const sync = (): void => {
    canInstall.value = deferredPrompt.value !== null && !installed.value;
  };

  onMounted(() => {
    wireOnce();
    sync();
    // Re-sync when the deferred prompt lands after mount.
    window.addEventListener("beforeinstallprompt", sync);
    window.addEventListener("appinstalled", sync);
  });
  onBeforeUnmount(() => {
    window.removeEventListener("beforeinstallprompt", sync);
    window.removeEventListener("appinstalled", sync);
  });

  /** Show the native install prompt. Returns whether the user accepted. */
  const promptInstall = async (): Promise<boolean> => {
    const p = deferredPrompt.value;
    if (!p) return false;
    await p.prompt();
    const { outcome } = await p.userChoice;
    // A deferred prompt is single-use — clear it either way.
    deferredPrompt.value = null;
    sync();
    return outcome === "accepted";
  };

  return { canInstall, promptInstall };
}
