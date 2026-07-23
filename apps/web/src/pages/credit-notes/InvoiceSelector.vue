<script setup lang="ts">
/**
 * Invoice picker — a thin wrapper over AutocompleteSearch's SERVER mode
 * (mirrors ClientSelector). Queries the invoices list endpoint
 * (`GET /v1/invoices`, list grammar: `q`/`limit=20`); shows the invoice number.
 * Emits the selected invoice id via `v-model`. Used for a credit note's
 * `creditedInvoiceId` (the finalized invoice being credited).
 *
 * EDIT-MODE: when a `modelValue` id is provided but the matching invoice is not
 * in the current results, we fetch that single invoice so the field renders its
 * number instead of a bare id.
 */
import { ref, computed, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import type { ListQuery } from "@/api/client";
import type { Invoice } from "@/types/domain";
import AutocompleteSearch from "@/components/AutocompleteSearch.vue";
import type { AutocompleteItem } from "@/components/AutocompleteSearch.vue";

const props = withDefaults(
  defineProps<{
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
}>();

const { t } = useI18n();

/** Edit-mode seed: the preselected invoice resolved by id (passed as :items). */
const seed = ref<Invoice[]>([]);

/** Row shape with a display label AutocompleteSearch can title on. */
interface InvoiceOption {
  id: string;
  label: string;
}

const toOption = (inv: Invoice): InvoiceOption => {
  const num = inv.invoiceNumber ?? t("creditNotes.selector.draftLabel");
  return { id: inv.id, label: num };
};

const fetchInvoices = async (q: string): Promise<AutocompleteItem[]> => {
  const query: ListQuery = { limit: 20, sort: "-issueDate", q: q.trim() || undefined };
  const result = await api.list<Invoice>("/v1/invoices", query);
  return result.data.map(toOption) as unknown as AutocompleteItem[];
};

const ensureSelectedLoaded = async (id: string): Promise<void> => {
  if (seed.value.some((c) => c.id === id)) return;
  try {
    const inv = await api.get<Invoice>(`/v1/invoices/${id}`);
    if (!seed.value.some((c) => c.id === inv.id)) {
      seed.value = [inv, ...seed.value];
    }
  } catch (err) {
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
  emit("update:modelValue", (value as string | null) ?? null);
};

const acRules = computed<(((v: unknown) => true | string)[]) | undefined>(
  () => props.rules as (((v: unknown) => true | string)[]) | undefined,
);

const seedItems = computed<AutocompleteItem[]>(
  () => seed.value.map(toOption) as unknown as AutocompleteItem[],
);
</script>

<template>
  <AutocompleteSearch
    :model-value="props.modelValue"
    :items="seedItems"
    :fetch="fetchInvoices"
    :label="props.label ?? t('creditNotes.selector.label')"
    :placeholder="t('creditNotes.selector.placeholder')"
    :disabled="props.disabled"
    :error-messages="props.errorMessages"
    :rules="acRules"
    :no-data-text="t('creditNotes.selector.noData')"
    item-title="label"
    item-value="id"
    :no-filter="true"
    clearable
    density="comfortable"
    prepend-inner-icon="mdi-file-search-outline"
    @update:model-value="onUpdate"
  />
</template>
