/**
 * useToast — a single, app-wide transient-message primitive (built on Vuetify's
 * v-snackbar, no external dependency). A module-level singleton holds a queue of
 * toasts; `ToastHost.vue` (mounted once in AppShell) renders them. Any component:
 *
 *   const { toast } = useToast();
 *   toast.success(t("clients.saved"));
 *   toast.error(t("common.saveFailed"));
 *
 * Mirrors the useConfirm singleton pattern: import `toast` + the shared `toasts`
 * queue directly in tests, drive it, assert.
 */
import { reactive } from "vue";

export type ToastTone = "success" | "error" | "info" | "warning";

export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
  timeout: number;
}

/** Shared reactive queue the host binds to (FIFO; host removes on close). */
export const toasts = reactive<ToastItem[]>([]);

let seq = 0;

const push = (text: string, tone: ToastTone, timeout: number): void => {
  seq += 1;
  toasts.push({ id: seq, text, tone, timeout });
};

export const dismissToast = (id: number): void => {
  const i = toasts.findIndex((tItem) => tItem.id === id);
  if (i !== -1) toasts.splice(i, 1);
};

export const toast = {
  success: (text: string, timeout = 3500): void => push(text, "success", timeout),
  error: (text: string, timeout = 5000): void => push(text, "error", timeout),
  info: (text: string, timeout = 3500): void => push(text, "info", timeout),
  warning: (text: string, timeout = 4000): void => push(text, "warning", timeout),
};

export const useToast = (): { toast: typeof toast } => {
  return { toast };
};
