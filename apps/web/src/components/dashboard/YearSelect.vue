<script setup lang="ts">
/**
 * Dashboard year selector. Lists every year in [minYear..maxYear] (from
 * GET /v1/dashboard/years, fetched by the parent) and v-models the active year
 * that drives every chart + KPI on the dashboard (recentActivity excepted).
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

const props = defineProps<{
  modelValue: number | null;
  minYear: number;
  maxYear: number;
}>();

const emit = defineEmits<{ "update:modelValue": [value: number] }>();

/** Descending [maxYear..minYear] so the current year sits at the top. */
const years = computed<number[]>(() => {
  const out: number[] = [];
  for (let y = props.maxYear; y >= props.minYear; y--) out.push(y);
  return out;
});

const selected = computed<number | null>({
  get: () => props.modelValue,
  set: (v) => {
    if (v != null) emit("update:modelValue", v);
  },
});
</script>

<template>
  <v-select
    v-model="selected"
    :items="years"
    :label="t('dashboard.year')"
    density="compact"
    hide-details
    variant="outlined"
    style="max-width: 140px"
    :aria-label="t('dashboard.year')"
  />
</template>
