<script setup lang="ts">
/**
 * Global year selector for the top app bar (Fatture-style "Anno 2026"). Reads +
 * writes the shared period store, so changing it re-scopes every page at once.
 * Rendered as a compact menu button (not a bulky v-select) to sit cleanly among
 * the other top-bar controls.
 */
import { computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { usePeriodStore } from "@/stores/period";

const { t } = useI18n();
const period = usePeriodStore();

onMounted(() => {
  void period.loadRange();
});

const label = computed<string>(() => t("period.year", { year: period.year }));
</script>

<template>
  <v-menu>
    <template #activator="{ props: menuProps }">
      <v-btn
        v-bind="menuProps"
        variant="tonal"
        color="primary"
        class="global-year-btn"
        append-icon="mdi-menu-down"
        :aria-label="label"
      >
        {{ label }}
      </v-btn>
    </template>
    <v-list density="compact" nav>
      <v-list-item
        v-for="y in period.years"
        :key="y"
        :active="y === period.year"
        :title="String(y)"
        @click="period.setYear(y)"
      >
        <template #prepend>
          <v-icon
            :icon="y === period.year ? 'mdi-check' : 'mdi-blank'"
            size="18"
          />
        </template>
      </v-list-item>
    </v-list>
  </v-menu>
</template>

<style scoped>
.global-year-btn {
  font-weight: 600;
  letter-spacing: 0.01em;
}
</style>
