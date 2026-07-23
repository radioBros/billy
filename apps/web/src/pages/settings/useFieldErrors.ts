/**
 * Maps `ApiError.details` (VALIDATION_FAILED) to a flat `{ field: message }` map
 * for binding to Vuetify `:error-messages`. Mirrors the pattern in the entity
 * form pages (e.g. ExpenseForm.applyValidationDetails).
 */
import { ref } from "vue";
import type { Ref } from "vue";
import { ApiError } from "@/api/client";

export interface FieldErrors {
  fieldErrors: Ref<Record<string, string>>;
  applyError: (err: unknown) => void;
  clear: () => void;
}

export const useFieldErrors = (): FieldErrors => {
  const fieldErrors = ref<Record<string, string>>({});

  function clear(): void {
    fieldErrors.value = {};
  }

  function applyError(err: unknown): void {
    clear();
    if (err instanceof ApiError && err.details && typeof err.details === "object") {
      for (const [k, v] of Object.entries(err.details)) {
        if (typeof v === "string") fieldErrors.value[k] = v;
      }
    }
  }

  return { fieldErrors, applyError, clear };
};
