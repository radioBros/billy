/**
 * useFormSubmit — one place that wires the "validate → on fail toast + scroll to
 * the first error → on pass run the submit" flow every form should share.
 *
 * Usage in a form:
 *   const formRef = ref<VForm | null>(null);
 *   const { submit, submitting } = useFormSubmit(formRef);
 *   ...
 *   <v-form ref="formRef" @submit.prevent="submit(save)">
 *
 * `save` is the caller's async submit fn. If Vuetify validation fails, `save` is
 * NOT called — instead an error toast fires and the view scrolls to the first
 * invalid field. This is the gating the old forms lacked (they submitted and
 * relied on the server round-trip).
 */
import { ref, type Ref } from "vue";
import { i18n } from "@/plugins/i18n";
import { toast } from "@/composables/useToast";

/** Minimal shape of Vuetify's v-form exposed API we depend on. */
export interface VuetifyFormRef {
  validate: () => Promise<{ valid: boolean }>;
}

/**
 * Scroll the first invalid field into view. Deferred so Vuetify has painted the
 * error state before we query for it.
 */
export const scrollToError = (): void => {
  setTimeout(() => {
    const el = document.querySelector(".v-field--error, .v-input--error");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, 200);
};

export interface UseFormSubmit {
  submit: (onValid: () => Promise<void> | void) => Promise<void>;
  submitting: Ref<boolean>;
}

export const useFormSubmit = (formRef: Ref<VuetifyFormRef | null>): UseFormSubmit => {
  const submitting = ref(false);
  const t = (key: string): string => i18n.global.t(key);

  const submit = async (onValid: () => Promise<void> | void): Promise<void> => {
    const form = formRef.value;
    if (form) {
      const { valid } = await form.validate();
      if (!valid) {
        toast.error(t("validations.formHasErrors"));
        scrollToError();
        return;
      }
    }
    submitting.value = true;
    try {
      await onValid();
    } finally {
      submitting.value = false;
    }
  };

  return { submit, submitting };
};
