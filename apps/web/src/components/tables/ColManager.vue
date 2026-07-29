<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import draggable from "vuedraggable";
import { useSettingsStore } from "@/stores/settings";

export interface ColManagerHeader {
  key: string;
  title: string;
  forced?: boolean;
  [key: string]: unknown;
}

const props = defineProps<{
  modelValue: string[];
  headers: ColManagerHeader[];
  tableName: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string[]): void;
  (e: "update:headers", value: ColManagerHeader[]): void;
}>();

const { t } = useI18n();
const settings = useSettingsStore();

const ACTION_KEYS = new Set(["_actions", "tableActions", "actions"]);

const isAction = (key: string) => ACTION_KEYS.has(key);
const isForced = (h: ColManagerHeader) => h.forced || isAction(h.key);

// ---- ordered list of all non-action headers (for drag list) ---------------
// Initialised from saved order or props.headers order on mount.
const orderedHeaders = ref<ColManagerHeader[]>([]);

onMounted(() => {
  const saved = settings.getTable(props.tableName);

  // Build base order from saved order or header definition order
  const orderKeys = saved?.order ?? props.headers.map((h) => h.key);
  const headerMap = Object.fromEntries(props.headers.map((h) => [h.key, h]));

  // Apply saved order for non-action headers, then append any new ones at end
  const ordered = orderKeys
    .filter((k) => !isAction(k) && headerMap[k])
    .map((k) => headerMap[k]!);
  const seen = new Set(ordered.map((h) => h.key));
  for (const h of props.headers) {
    if (!isAction(h.key) && !seen.has(h.key)) ordered.push(h);
  }
  orderedHeaders.value = ordered;

  // Restore saved visibility
  if (saved?.visibility) {
    const forced = props.headers.filter(isForced).map((h) => h.key);
    const merged = [...new Set([...saved.visibility, ...forced])].filter(
      (k) => props.headers.some((h) => h.key === k),
    );
    emit("update:modelValue", merged);
  }

  // Emit initial header order (actions col always goes last)
  _emitHeaderOrder(orderedHeaders.value);
});

// ---- emit header order to parent (actions col appended at end) -------------
const _emitHeaderOrder = (ordered: ColManagerHeader[]) => {
  const actionHeaders = props.headers.filter((h) => isAction(h.key));
  emit("update:headers", [...ordered, ...actionHeaders]);
};

// ---- drag handler ----------------------------------------------------------
const onDragEnd = () => {
  settings.setOrder(
    props.tableName,
    orderedHeaders.value.map((h) => h.key),
  );
  _emitHeaderOrder(orderedHeaders.value);
};

// ---- toggle visibility -----------------------------------------------------
const toggle = (key: string): void => {
  if (isAction(key)) return;
  const isVisible = props.modelValue.includes(key);
  const next = isVisible
    ? props.modelValue.filter((k) => k !== key)
    : [...new Set([...props.modelValue, key])];
  // Always keep forced + action keys visible
  for (const h of props.headers) {
    if (isForced(h) && !next.includes(h.key)) next.push(h.key);
  }
  emit("update:modelValue", next);
  settings.setVisibility(props.tableName, next);
};

// ---- draggable model -------------------------------------------------------
const draggableList = computed({
  get: () => orderedHeaders.value,
  set: (val) => { orderedHeaders.value = val; },
});
</script>

<template>
  <v-menu
    :close-on-content-click="false"
    location="bottom end"
  >
    <template #activator="{ props: menuProps }">
      <v-btn
        v-bind="menuProps"
        icon="mdi-table-cog"
        size="small"
        variant="tonal"
        color="primary"
        :ripple="false"
        :aria-label="t('tables.configure_columns')"
      >
        <v-icon icon="mdi-table-cog" />
        <v-tooltip activator="parent" location="bottom">
          {{ t('tables.configure_columns') }}
        </v-tooltip>
      </v-btn>
    </template>

    <v-card
      min-width="220"
      max-width="280"
      rounded="lg"
      elevation="4"
    >
      <v-card-title
        class="fs-12 font-weight-bold py-1 px-3 auto-h"
        style="letter-spacing: 0.08em; text-transform: uppercase; color: var(--v-billy-text-3);"
      >
        {{ t('tables.configure_columns') }}
      </v-card-title>
      <v-divider />

      <draggable
        v-model="draggableList"
        item-key="key"
        handle=".col-drag-handle"
        :animation="180"
        tag="div"
        @end="onDragEnd"
      >
        <template #item="{ element: header }">
          <v-list-item
            :key="header.key"
            :disabled="header.forced"
            :active="modelValue.includes(header.key)"
            active-color="primary"
            density="compact"
            rounded="0"
            class="px-2 my-px"
            @click="!header.forced && toggle(header.key)"
          >
            <template #prepend>
              <v-icon
                class="col-drag-handle mr-1"
                size="16"
                style="cursor: grab; opacity: 0.4;"
                @click.stop
              >
                mdi-drag-vertical
              </v-icon>
              <v-icon size="18" class="mr-2">
                {{ modelValue.includes(header.key) ? 'mdi-checkbox-marked' : 'mdi-checkbox-blank-outline' }}
              </v-icon>
            </template>
            <v-list-item-title class="text-body-medium">
              {{ header.title }}
            </v-list-item-title>
          </v-list-item>
        </template>
      </draggable>
    </v-card>
  </v-menu>
</template>
