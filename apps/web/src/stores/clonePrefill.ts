/**
 * useClonePrefillStore — a tiny Pinia scratch buffer that carries a cloned
 * record's seed fields from a list row to the matching create form. Route state
 * would be lost on reload; this store survives the single navigation and is
 * consumed (cleared) by the create view on mount so a later fresh "New" is never
 * accidentally pre-seeded.
 *
 * The buffer is keyed by document type so an invoice clone can't leak into a
 * quote create. Values are the STRIPPED seed (no id/number/status/payments/
 * issue-stamps) produced by `useClonePrefill`.
 */
import { defineStore } from "pinia";
import { ref } from "vue";

/** The doc/entry types that support cloning (clients excluded — no create route). */
export type ClonableType =
  | "invoice"
  | "quote"
  | "proforma"
  | "credit-note"
  | "contract"
  | "expense";

export const useClonePrefillStore = defineStore("clonePrefill", () => {
  const type = ref<ClonableType | null>(null);
  const seed = ref<Record<string, unknown> | null>(null);

  /** Stash a stripped seed for the given type (called before navigating to create). */
  function set(t: ClonableType, data: Record<string, unknown>): void {
    type.value = t;
    seed.value = data;
  }

  /**
   * Consume the seed for `t` exactly once. Returns the seed and clears the
   * buffer so a subsequent plain "New" starts empty. Returns null if the buffer
   * holds nothing for this type.
   */
  function consume(t: ClonableType): Record<string, unknown> | null {
    if (type.value !== t || !seed.value) return null;
    const out = seed.value;
    type.value = null;
    seed.value = null;
    return out;
  }

  return { type, seed, set, consume };
});
