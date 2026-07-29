/**
 * useConfirm — a single, app-wide confirmation primitive. A module-level
 * singleton holds the dialog state; `ConfirmDialog.vue` (mounted once in
 * AppShell) renders it. Any component calls `confirm(...)` and awaits a boolean:
 *
 *   const ok = await confirm({ title, message, confirmText?, cancelText?, tone? });
 *   if (!ok) return;
 *
 * The singleton (over provide/inject) keeps callers dependency-free and is
 * trivially unit-testable: import `confirm` + the shared `state`, drive it, and
 * resolve via `resolveConfirm`.
 */
import { reactive } from "vue";

export type ConfirmTone = "primary" | "error" | "warning";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** Colours the confirm button; `error`/`warning` for destructive/lifecycle actions. */
  tone?: ConfirmTone;
}

interface ConfirmState {
  open: boolean;
  title: string;
  message: string;
  confirmText: string | null;
  cancelText: string | null;
  tone: ConfirmTone;
}

/** Shared reactive state the host dialog binds to. */
export const confirmState = reactive<ConfirmState>({
  open: false,
  title: "",
  message: "",
  confirmText: null,
  cancelText: null,
  tone: "primary",
});

let resolver: ((value: boolean) => void) | null = null;

export const confirm = (opts: ConfirmOptions): Promise<boolean> => {
  // If a prior prompt is somehow still pending, reject it as cancelled.
  if (resolver) {
    resolver(false);
    resolver = null;
  }
  confirmState.title = opts.title;
  confirmState.message = opts.message;
  confirmState.confirmText = opts.confirmText ?? null;
  confirmState.cancelText = opts.cancelText ?? null;
  confirmState.tone = opts.tone ?? "primary";
  confirmState.open = true;
  return new Promise<boolean>((resolve) => {
    resolver = resolve;
  });
};

export const resolveConfirm = (value: boolean): void => {
  confirmState.open = false;
  if (resolver) {
    resolver(value);
    resolver = null;
  }
};

export const useConfirm = (): { confirm: typeof confirm } => {
  return { confirm };
};
