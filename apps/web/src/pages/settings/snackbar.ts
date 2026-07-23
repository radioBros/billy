/** Shared success-snackbar injection contract for the customization tabs. */
import type { InjectionKey } from "vue";

export type NotifyFn = (text: string) => void;

export const SNACKBAR_KEY: InjectionKey<NotifyFn> = Symbol("customization-snackbar");

/** Default no-op so a tab rendered outside the panel (e.g. a test) doesn't crash. */
export const NOOP_NOTIFY: NotifyFn = () => {};
