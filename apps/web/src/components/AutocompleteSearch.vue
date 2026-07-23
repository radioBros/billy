<template>
  <v-select
    v-model="value"
    :items="displayItems"
    :item-title="itemTitle ?? 'title'"
    :item-value="itemValue ?? 'value'"
    :label="label"
    :rules="rules"
    :loading="serverMode ? loading : undefined"
    ref="selectEl"
    v-bind="$attrs"
    @update:menu="onMenuChange"
  >
    <template #prepend-item>
      <div
        class="px-2 pb-0 pt-2 sticky bg-background"
        style="top: -8px; left: 0; right: 0; z-index: 2; position: sticky;"
      >
        <v-text-field
          ref="searchInputEl"
          v-model="searchText"
          :placeholder="placeholder ?? 'Search…'"
          v-bind="searchAtts ?? {}"
          variant="outlined"
          density="compact"
          autocomplete="off"
          type="search"
          data-lpignore="true"
          data-testid="autocomplete-search-input"
          autofocus
          hide-details
          @keydown.space.stop
          @keydown.tab.stop
        />
        <v-divider class="mt-2 mb-0 bg-grey" />
      </div>
    </template>

    <template v-slot:item="data">
      <slot
        name="item"
        :props="data.props"
        :item="data.item"
        :index="data.index"
      >
        <v-list-item
          :title="getItemTitle(data.item)"
          :data-testid="getItemValue(data.item)"
          v-bind="data.props"
        />
      </slot>
    </template>

    <template
      v-if="slots.selection"
      v-slot:selection="data"
    >
      <slot
        name="selection"
        :item="data.item"
        :index="data.index"
      />
    </template>

    <template #no-data>
      <slot name="no-data">
        <div class="pa-3 text-body-2" style="color: var(--v-billy-text-3);">
          {{ serverMode && loadError ? loadError : (noDataText ?? 'No results') }}
        </div>
      </slot>
    </template>

    <template
      v-if="slots.append"
      #append-item
    >
      <slot name="append" />
    </template>

    <template
      v-if="slots['append-outer']"
      #append
    >
      <slot name="append-outer" />
    </template>
  </v-select>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useSlots, watch } from "vue";

// ---- Types ------------------------------------------------------------------

/**
 * An option object. The configured `item-title` / `item-value` keys are read
 * reflectively at runtime, so the shape is open. Domain objects (e.g. `Client`)
 * are passed via `:items` / returned from `:fetch` with an explicit cast at the
 * call site (see ClientSelector) — TS's weak-type check requires it.
 */
export interface AutocompleteItem {
  title?: string;
  value?: string | number;
  [key: string]: unknown;
}

/** Internal alias. */
type Item = AutocompleteItem;

/**
 * Server-mode fetch callback. Receives the debounced query text; returns the
 * matching items (the caller queries the resource list endpoint with
 * `q=` + `limit=20`). When present, the component switches to SERVER mode:
 * `:items` is treated as a seed (e.g. a preselected value) and the fetch drives
 * the option list. When absent, the component stays in STATIC mode and filters
 * `:items` client-side.
 */
type FetchFn = (q: string) => Promise<AutocompleteItem[]>;

// ---- Props & emits ----------------------------------------------------------

const props = withDefaults(
  defineProps<{
    modelValue: string | number | Array<string | number> | null;
    items?: Item[];
    label?: string;
    placeholder?: string;
    rules?: ((v: unknown) => true | string)[];
    itemTitle?: string;
    itemValue?: string;
    clearable?: boolean;
    disabled?: boolean;
    searchFields?: string[];
    searchAtts?: Record<string, unknown> | null;
    /** SERVER mode: async query of the resource list endpoint (debounced ~320ms). */
    fetch?: FetchFn | null;
    /** SERVER mode: debounce for the query (ms). */
    debounce?: number;
    /** Empty-state text (both modes). */
    noDataText?: string;
  }>(),
  {
    items: () => [],
    label: undefined,
    placeholder: undefined,
    rules: () => [],
    itemTitle: undefined,
    itemValue: undefined,
    clearable: false,
    disabled: false,
    searchFields: () => [],
    searchAtts: null,
    fetch: null,
    debounce: 320,
    noDataText: undefined,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string | number | Array<string | number> | null];
}>();

const slots = useSlots();

// ---- Refs -------------------------------------------------------------------

const selectEl = ref<{ reset: () => void } | null>(null);
const searchInputEl = ref<{ focus: () => void } | null>(null);
const searchText = ref<string>("");

// ---- Mode -------------------------------------------------------------------

const serverMode = computed<boolean>(() => typeof props.fetch === "function");

// ---- v-model passthrough ----------------------------------------------------

const value = computed({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});

// ---- Item helpers -----------------------------------------------------------

const titleKey = computed<string>(() => props.itemTitle ?? "title");
const valueKey = computed<string>(() => props.itemValue ?? "value");

// In Vuetify the #item slot's `data.item` is the ORIGINAL object passed in
// `:items` (the wrapper is `data.internalItem`). So read the configured
// item-title / item-value key straight off it (supports dotted paths).
const getByPath = (obj: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], obj);

const getItemTitle = (item: unknown): string => {
  const key = titleKey.value;
  const v = key.includes(".") ? getByPath(item, key) : (item as Record<string, unknown>)?.[key];
  return v == null ? "" : String(v);
};

const getItemValue = (item: unknown): string => {
  const key = valueKey.value;
  const v = key.includes(".") ? getByPath(item, key) : (item as Record<string, unknown>)?.[key];
  return v == null ? "" : String(v);
};

// ---- Static filter ----------------------------------------------------------

const matchesSearch = (item: Item, text: string): boolean => {
  const rec = item as Record<string, unknown>;
  const haystack = [rec[titleKey.value], ...props.searchFields.map((f) => rec[f])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(text.toLowerCase());
};

const normalizeItems = (raw: Item[]): Item[] => {
  if (raw.length === 0) return raw;
  if (typeof raw[0] !== "string") return raw;
  return (raw as unknown as string[]).map((a) => ({ title: a, value: a }));
};

// ---- Server mode: debounced fetch + request-seq guard + edit-mode seed ------
// (folds in the ClientSelector pattern: a slow response can never overwrite a
// newer one, and a preselected value that isn't in the results is preserved so
// its chip keeps its label.)

const serverItems = ref<Item[]>([]);
const loading = ref<boolean>(false);
const loadError = ref<string | null>(null);

let requestSeq = 0;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

const findSeed = (id: string | number): Item | undefined => {
  // Prefer an item we've already resolved (server results or props.items seed).
  const inResults = serverItems.value.find((i) => getItemValue(i) === String(id));
  if (inResults) return inResults;
  return normalizeItems(props.items).find((i) => getItemValue(i) === String(id));
};

const runFetch = async (q: string): Promise<void> => {
  if (!props.fetch) return;
  const seq = ++requestSeq;
  loading.value = true;
  loadError.value = null;
  try {
    const results = await props.fetch(q);
    if (seq !== requestSeq) return;
    // Preserve the currently-selected item so its chip keeps its label even
    // when it falls outside the fresh result window.
    const sel = props.modelValue;
    const selId = Array.isArray(sel) ? undefined : sel;
    const seed = selId != null ? findSeed(selId) : undefined;
    const merged =
      seed && !results.some((i) => getItemValue(i) === getItemValue(seed))
        ? [seed, ...results]
        : results;
    serverItems.value = merged;
  } catch {
    if (seq !== requestSeq) return;
    loadError.value = props.noDataText ?? "Could not search";
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
};

// Debounced reaction to typing (server mode only).
watch(searchText, (q) => {
  if (!serverMode.value) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void runFetch(q), props.debounce);
});

onMounted(() => {
  if (serverMode.value) void runFetch("");
});

// Edit-mode seed: if a preselected id lands and it isn't in the current list,
// re-fetch so the option (and its label) resolve.
watch(
  () => props.modelValue,
  (id) => {
    if (!serverMode.value || id == null || Array.isArray(id)) return;
    if (serverItems.value.some((i) => getItemValue(i) === String(id))) return;
    void runFetch(searchText.value);
  },
);

// ---- Displayed items --------------------------------------------------------
// STATIC: client-side filter of :items.  SERVER: the fetched list, with the
// seed items from `:items` (e.g. an edit-mode preselected value) merged in and
// deduped — so a selected value that isn't in the current result window still
// has a resolvable title/chip. Vuetify's own filter is disabled by the caller
// via `:no-filter` in $attrs when needed; we pass results through untouched.

const displayItems = computed<Item[]>(() => {
  if (serverMode.value) {
    const seed = normalizeItems(props.items);
    if (seed.length === 0) return serverItems.value;
    const seen = new Set(serverItems.value.map((i) => getItemValue(i)));
    const extraSeed = seed.filter((i) => !seen.has(getItemValue(i)));
    return extraSeed.length ? [...extraSeed, ...serverItems.value] : serverItems.value;
  }
  const items = normalizeItems(props.items);
  const text = searchText.value.trim();
  if (!text) return items;
  return items.filter((item) => matchesSearch(item, text));
});

// ---- Menu open: clear search + autofocus ------------------------------------

const onMenuChange = async (open: boolean): Promise<void> => {
  if (open) {
    searchText.value = "";
    await nextTick();
    searchInputEl.value?.focus();
  }
};

// ---- Exposed API ------------------------------------------------------------

const reset = (): void => {
  searchText.value = "";
  selectEl.value?.reset();
};

defineExpose({ reset });
</script>
