<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

const props = withDefaults(
  defineProps<{
    page: number;
    ipp: number;
    total: number;
    pageCount: number;
    pageSizeOptions?: number[];
  }>(),
  {
    pageSizeOptions: () => [10, 25, 50, 100],
  },
);

const emit = defineEmits<{
  (e: "update:page", value: number): void;
  (e: "update:ipp", value: number): void;
}>();

const { t } = useI18n();

const safePageCount = computed(() => Math.max(1, props.pageCount || 1));

const from = computed(() => {
  if (!props.total || !props.ipp) return 0;
  return Math.min((props.page - 1) * props.ipp + 1, props.total);
});

const to = computed(() => {
  if (!props.ipp) return 0;
  return Math.min(props.page * props.ipp, props.total);
});

const pageSizeItems = computed(() =>
  props.pageSizeOptions.map((n) => ({ value: n, title: String(n) })),
);
</script>

<template>
  <div class="table-footer px-5 py-2">
    <div class="table-footer__left">
      <div class="table-footer__ipp">
        <span class="table-footer__label">{{ t('tables.show') }}</span>
        <v-select
          :model-value="ipp"
          :items="pageSizeItems"
          density="compact"
          variant="outlined"
          hide-details
          class="table-footer__ipp-select no-validation"
          style="min-width: 90px;"
          @update:model-value="emit('update:ipp', Number($event))"
        />
        <span class="table-footer__label">{{ t('tables.entries') }}</span>
      </div>
    </div>

    <v-pagination
      :model-value="page"
      :length="safePageCount"
      :total-visible="safePageCount > 10 ? 5 : safePageCount > 5 ? 4 : 3"
      density="compact"
      variant="tonal"
      color="primary"
      show-first-last-page
      class="table-footer__pagination"
      @update:model-value="emit('update:page', $event)"
    />

    <div class="table-footer__right">
      <span class="table-footer__summary">
        {{ t('tables.showing_items', { from, to, total }) }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.table-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  border-top: 1px solid var(--v-billy-border);
}

@media (max-width: 700px) {
  .table-footer {
    flex-direction: column;
    align-items: flex-start;
  }
}

.table-footer__left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.table-footer__ipp {
  display: flex;
  align-items: center;
  gap: 6px;
}

.table-footer__ipp-select {
  width: 72px;
}

.table-footer__label {
  font-size: 13px;
  color: var(--v-billy-text-2);
  white-space: nowrap;
}

.table-footer__pagination {
  flex: 1 1 auto;
}

.table-footer__right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.table-footer__summary {
  font-size: 13px;
  color: var(--v-billy-text-2);
  white-space: nowrap;
}
</style>
