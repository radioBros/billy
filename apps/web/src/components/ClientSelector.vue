<script setup lang="ts">
/**
 * Reusable client picker — a thin wrapper over AutocompleteSearch's SERVER mode
 * (ClientSelector → server). Queries the clients
 * list endpoint (`GET /api/v1/clients`, list grammar: `q`/`limit=20`); the
 * component debounces the query and guards it with a request-sequence internally.
 * Emits the selected client id via `v-model`; shows the display name.
 *
 * EDIT-MODE: when a `modelValue` id is provided but the matching client is not in
 * the current search results, we fetch that single client so the field renders its
 * name instead of a bare id (seeded into `:items`, AutocompleteSearch preserves it).
 */
import { ref, computed, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import type { ListQuery } from "@/api/client";
import type { Client } from "@/types/domain";
import AutocompleteSearch from "@/components/AutocompleteSearch.vue";
import type { AutocompleteItem } from "@/components/AutocompleteSearch.vue";

const props = withDefaults(
  defineProps<{
    /** Selected client id (v-model). */
    modelValue: string | null;
    label?: string;
    disabled?: boolean;
    errorMessages?: string | string[];
    rules?: ((v: unknown) => boolean | string)[];
  }>(),
  { modelValue: null, label: undefined, disabled: false, errorMessages: undefined, rules: undefined },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: string | null): void;
  /** The selected client's preferred language (base code, e.g. "it") or null.
   *  Lets the host form show "write open-text in this language" hints. */
  (e: "client-locale", value: string | null): void;
}>();

const { t } = useI18n();

/** Edit-mode seed: the preselected client resolved by id (passed as :items). */
const seed = ref<Client[]>([]);

const fetchClients = async (q: string): Promise<AutocompleteItem[]> => {
  const query: ListQuery = { limit: 20, sort: "displayName", q: q.trim() || undefined };
  const result = await api.list<Client>("/v1/clients", query);
  // Cache results into the seed so a freshly-picked client's language is known
  // to `emitLocaleFor` without an extra fetch.
  const known = new Set(seed.value.map((c) => c.id));
  const fresh = result.data.filter((c) => !known.has(c.id));
  if (fresh.length) seed.value = [...seed.value, ...fresh];
  return result.data as unknown as AutocompleteItem[];
};

/** Emit the preferred language of the currently-selected client (if resolved). */
const emitLocaleFor = (id: string | null): void => {
  if (!id) {
    emit("client-locale", null);
    return;
  }
  const c = seed.value.find((x) => x.id === id);
  if (c) emit("client-locale", c.preferredLanguage ?? null);
};

const ensureSelectedLoaded = async (id: string): Promise<void> => {
  if (seed.value.some((c) => c.id === id)) {
    emitLocaleFor(id);
    return;
  }
  try {
    const client = await api.get<Client>(`/v1/clients/${id}`);
    if (!seed.value.some((c) => c.id === client.id)) {
      seed.value = [client, ...seed.value];
    }
    emitLocaleFor(id);
  } catch (err) {
    // Non-fatal: the field falls back to showing the raw id.
    if (!(err instanceof ApiError)) throw err;
  }
};

onMounted(() => {
  if (props.modelValue) void ensureSelectedLoaded(props.modelValue);
});

watch(
  () => props.modelValue,
  (id) => {
    if (id) void ensureSelectedLoaded(id);
  },
);

const onUpdate = (value: string | number | Array<string | number> | null): void => {
  const id = (value as string | null) ?? null;
  emit("update:modelValue", id);
  emitLocaleFor(id);
};

// AutocompleteSearch types rules as `() => true | string`; Vuetify (and this
// component's public contract) allow `boolean`. Adapt at the boundary.
const acRules = computed<(((v: unknown) => true | string)[]) | undefined>(
  () => props.rules as (((v: unknown) => true | string)[]) | undefined,
);

/** The edit-mode seed as AutocompleteItem[] (Client → open option shape). */
const seedItems = computed<AutocompleteItem[]>(() => seed.value as unknown as AutocompleteItem[]);
</script>

<template>
  <AutocompleteSearch
    :model-value="props.modelValue"
    :items="seedItems"
    :fetch="fetchClients"
    :label="props.label ?? t('clients.selector.label')"
    :placeholder="t('clients.selector.placeholder')"
    :disabled="props.disabled"
    :error-messages="props.errorMessages"
    :rules="acRules"
    :no-data-text="t('clients.selector.noData')"
    item-title="displayName"
    item-value="id"
    :no-filter="true"
    clearable
    density="comfortable"
    prepend-inner-icon="mdi-account-search-outline"
    @update:model-value="onUpdate"
  />
</template>
