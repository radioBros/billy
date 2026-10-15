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
import { useIsMobile } from "@/composables/useIsMobile";

const { t } = useI18n();
const period = usePeriodStore();
const isMobile = useIsMobile();

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
        :class="{ 'global-year-btn--mobile': isMobile }"
        append-icon="mdi-menu-down"
        :aria-label="label"
      >
        <!-- Phone app bar is tight: just "2026" + caret (the aria-label keeps "Year 2026"). -->
        {{ isMobile ? period.year : label }}
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
.global-year-btn--mobile {
  height: 40px !important;
  min-width: 0 !important;
  padding: 0 6px 0 12px !important;
  font-variant-numeric: tabular-nums;
}
.global-year-btn--mobile :deep(.v-btn__append) {
  margin-inline-start: 2px;
}
</style>
