<script setup lang="ts">
/**
 * Optional project picker — a thin wrapper over AutocompleteSearch's SERVER mode
 * (queries GET /api/v1/projects). Emits the selected project id via v-model;
 * shows the project name. Clearable (projects are always optional on documents).
 * Mirrors ClientSelector.
 */
import { ref, computed, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import type { ListQuery } from "@/api/client";
import AutocompleteSearch from "@/components/AutocompleteSearch.vue";
import type { AutocompleteItem } from "@/components/AutocompleteSearch.vue";

interface Project {
  id: string;
  name: string;
}

const props = withDefaults(
  defineProps<{
    modelValue: string | null;
    label?: string;
    disabled?: boolean;
    errorMessages?: string | string[];
  }>(),
  { modelValue: null, label: undefined, disabled: false, errorMessages: undefined },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: string | null): void;
}>();

const { t } = useI18n();

const seed = ref<Project[]>([]);

const fetchProjects = async (q: string): Promise<AutocompleteItem[]> => {
  const query: ListQuery = { limit: 20, sort: "name", q: q.trim() || undefined };
  const result = await api.list<Project>("/v1/projects", query);
  return result.data as unknown as AutocompleteItem[];
};

const ensureSelectedLoaded = async (id: string): Promise<void> => {
  if (seed.value.some((p) => p.id === id)) return;
  try {
    const project = await api.get<Project>(`/v1/projects/${id}`);
    if (!seed.value.some((p) => p.id === project.id)) seed.value = [project, ...seed.value];
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

const seedItems = computed<AutocompleteItem[]>(() => seed.value as unknown as AutocompleteItem[]);
</script>

<template>
  <AutocompleteSearch
    :model-value="props.modelValue"
    :items="seedItems"
    :fetch="fetchProjects"
    :label="props.label ?? t('projects.selector.label')"
    :placeholder="t('projects.selector.placeholder')"
    :disabled="props.disabled"
    :error-messages="props.errorMessages"
    :no-data-text="t('projects.selector.noData')"
    item-title="name"
    item-value="id"
    :no-filter="true"
    clearable
    density="comfortable"
    prepend-inner-icon="mdi-folder-outline"
    @update:model-value="onUpdate"
  />
</template>
