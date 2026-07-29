<script setup lang="ts">
/**
 * Country picker. Binds the ISO 3166-1 alpha-2 CODE (v-model), displays the
 * localized country name in the active locale. Searchable, no free text — the
 * user can only pick a real country code. Use in place of a free-text country
 * field so the stored value is always a valid code.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { countryOptions } from "@/constants/countries";

const props = defineProps<{
  modelValue: string | null | undefined;
  label?: string;
  rules?: ((v: unknown) => boolean | string)[];
  errorMessages?: string | string[];
  density?: "default" | "comfortable" | "compact";
  disabled?: boolean;
  clearable?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string | null];
}>();

const { locale } = useI18n();

const items = computed(() => countryOptions(locale.value));

const value = computed<string | null>({
  get: () => props.modelValue ?? null,
  set: (v) => emit("update:modelValue", v),
});
</script>

<template>
  <v-autocomplete
    v-model="value"
    :items="items"
    item-title="title"
    item-value="value"
    :label="label"
    :rules="rules"
    :error-messages="errorMessages"
    :density="density ?? 'comfortable'"
    :disabled="disabled"
    :clearable="clearable"
    autocomplete="off"
  />
</template>
