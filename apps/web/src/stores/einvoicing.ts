/**
 * useEInvoicing — one cached answer to "is Italian e-invoicing (SdI) on for this
 * account?", so every page can hide the whole integration when it is off.
 *
 * Admins (canManageSettings) read the full view from `GET /v1/settings/einvoicing`.
 * Everyone else may get 403 there, so they fall back to the `enabled` flag of
 * `GET /v1/einvoicing/summary`. Any failure resolves to "disabled" — the feature
 * must never break a page that doesn't use it.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/api/client";
import { useAuthStore } from "@/stores/auth";
import type { EInvoicingSettings, EInvoicingSummary } from "@/types/domain";

export const useEInvoicing = defineStore("einvoicing", () => {
  const settings = ref<EInvoicingSettings | null>(null);
  const summary = ref<EInvoicingSummary | null>(null);
  const loaded = ref(false);
  let inflight: Promise<void> | null = null;

  const enabled = computed<boolean>(() => settings.value?.enabled ?? summary.value?.enabled ?? false);

  // Behaviour defaults. Non-admins can't read the settings, so they use the
  // optional hints on the summary; the offer-step default is "on" (the preflight
  // and submit endpoints are the real gate), the opt-in defaults are "off".
  const offerStepAfterFinalize = computed<boolean>(
    () => settings.value?.offerStepAfterFinalize ?? summary.value?.offerStepAfterFinalize ?? true,
  );
  const scheduledDefaultSubmit = computed<boolean>(
    () => settings.value?.scheduledDefaultSubmit ?? summary.value?.scheduledDefaultSubmit ?? false,
  );
  const recurringDefaultSubmit = computed<boolean>(
    () => settings.value?.recurringDefaultSubmit ?? summary.value?.recurringDefaultSubmit ?? false,
  );

  const fetchOnce = async (): Promise<void> => {
    const auth = useAuthStore();
    if (auth.principal?.capabilities.canManageSettings === true) {
      try {
        settings.value = await api.get<EInvoicingSettings>("/v1/settings/einvoicing");
        return;
      } catch {
        // fall through to the summary probe (e.g. 403)
      }
    }
    try {
      const s = await api.get<EInvoicingSummary>("/v1/einvoicing/summary");
      summary.value = s && typeof s === "object" ? s : null;
    } catch {
      summary.value = null;
    }
  };

  /** Load once (idempotent, de-duplicated); `force` re-fetches. Never throws. */
  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return;
    if (inflight) return inflight;
    inflight = fetchOnce().finally(() => {
      loaded.value = true;
      inflight = null;
    });
    return inflight;
  }

  /** Re-fetch the not-sent summary (dashboard list). Only meaningful when enabled. */
  async function loadSummary(): Promise<EInvoicingSummary | null> {
    try {
      const s = await api.get<EInvoicingSummary>("/v1/einvoicing/summary");
      summary.value = s && typeof s === "object" ? s : null;
    } catch {
      summary.value = null;
    }
    return summary.value;
  }

  /** The settings tab pushes every saved view here so the rest of the app follows. */
  function applyView(view: EInvoicingSettings): void {
    settings.value = view;
    loaded.value = true;
  }

  function reset(): void {
    settings.value = null;
    summary.value = null;
    loaded.value = false;
    inflight = null;
  }

  return {
    settings,
    summary,
    loaded,
    enabled,
    offerStepAfterFinalize,
    scheduledDefaultSubmit,
    recurringDefaultSubmit,
    load,
    loadSummary,
    applyView,
    reset,
  };
});
