<script setup lang="ts">
/**
 * Address autocomplete (open-source, via the server-side Geoapify proxy at
 * /api/v1/geo/autocomplete — the API key never reaches the browser). As the user
 * types a street, it suggests full addresses; picking one emits ALL parts
 * (line1, house/civic number, city, postal code, region, country) so the form
 * fills every address field at once. Every field stays manually editable, and
 * when Geoapify is not configured the input is a plain text field for line1.
 */
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/api/client";

export interface ResolvedAddress {
  line1: string;
  houseNumber: string;
  street: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

interface Suggestion extends ResolvedAddress {
  label: string;
}

const props = defineProps<{
  /** Bound to the address line1 field (two-way). */
  modelValue: string;
  label?: string;
  rules?: ((v: unknown) => boolean | string)[];
  errorMessages?: string | string[];
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  /** Fired when a suggestion is picked — the form fills every address part. */
  resolved: [addr: ResolvedAddress];
}>();

const { t } = useI18n();

const search = ref(props.modelValue ?? "");
const suggestions = ref<Suggestion[]>([]);
const loading = ref(false);
let debounce: ReturnType<typeof setTimeout> | null = null;

watch(
  () => props.modelValue,
  (v) => {
    if (v !== search.value) search.value = v ?? "";
  },
);

watch(search, (q) => {
  emit("update:modelValue", q);
  if (debounce) clearTimeout(debounce);
  if (!q || q.trim().length < 3) {
    suggestions.value = [];
    return;
  }
  debounce = setTimeout(async () => {
    loading.value = true;
    try {
      const res = await api.get<{ suggestions: Suggestion[] }>("/v1/geo/autocomplete", { q });
      suggestions.value = res.suggestions ?? [];
    } catch {
      suggestions.value = [];
    } finally {
      loading.value = false;
    }
  }, 320);
});

const onSelect = (label: string | null): void => {
  const picked = suggestions.value.find((s) => s.label === label);
  if (!picked) return;
  // Fill line1 with street + house number (the civic number the OSS providers
  // sometimes drop — we surface it explicitly so it's never lost silently).
  emit("update:modelValue", picked.line1);
  search.value = picked.line1;
  emit("resolved", {
    line1: picked.line1,
    houseNumber: picked.houseNumber,
    street: picked.street,
    city: picked.city,
    region: picked.region,
    postalCode: picked.postalCode,
    country: picked.country,
  });
};
</script>

<template>
  <v-combobox
    v-model:search="search"
    :model-value="props.modelValue"
    :items="suggestions"
    item-title="label"
    item-value="label"
    :label="props.label ?? t('address.line1')"
    :rules="props.rules"
    :error-messages="props.errorMessages"
    :loading="loading"
    :return-object="false"
    no-filter
    auto-select-first
    density="comfortable"
    prepend-inner-icon="mdi-map-marker-outline"
    @update:model-value="onSelect"
  />
</template>
