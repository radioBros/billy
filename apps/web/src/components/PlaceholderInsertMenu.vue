<script setup lang="ts">
/**
 * PlaceholderInsertMenu — the right-click menu that pairs with usePlaceholderInsert.
 *
 * Renders `placeholdersForDocType(docType)` grouped by `group` (date → document →
 * client → company) at the cursor position captured in `state`. Clicking a row emits
 * `insert` with the token's exact `insert` text; the composable does the caret work.
 *
 * Positioning uses Vuetify's `:target="[x, y]"` (viewport coords) — the idiomatic
 * "menu at cursor" for Vuetify 3.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  placeholdersForDocType,
  type PlaceholderDocType,
  type PlaceholderGroup,
  type PlaceholderInfo,
} from "@billy/shared/template";
import {
  DATE_EXAMPLE_PARAMS,
  type PlaceholderMenuState,
} from "@/composables/usePlaceholderInsert";

const props = defineProps<{
  state: PlaceholderMenuState;
  docType: PlaceholderDocType;
}>();

const emit = defineEmits<{ insert: [text: string] }>();

const { t } = useI18n();

/** Legend/menu grouping order — shared with PlaceholderLegend. */
const GROUP_ORDER: readonly PlaceholderGroup[] = ["date", "document", "client", "company"];

const grouped = computed<{ group: PlaceholderGroup; items: PlaceholderInfo[] }[]>(() => {
  const all = placeholdersForDocType(props.docType);
  return GROUP_ORDER.map((group) => ({
    group,
    items: all.filter((p) => p.group === group),
  })).filter((g) => g.items.length > 0);
});

// v-menu owns `open` internally via v-model; write back through the shared state.
const open = computed({
  get: () => props.state.open,
  set: (v: boolean) => {
    props.state.open = v;
  },
});
</script>

<template>
  <v-menu
    v-model="open"
    :target="[state.x, state.y]"
    :close-on-content-click="false"
    location="bottom start"
  >
    <v-card min-width="280" max-width="420" rounded="lg" class="placeholder-menu">
      <v-list density="compact" class="py-1">
        <v-list-subheader class="text-medium-emphasis">
          {{ t("placeholders.insertMenuTitle") }}
        </v-list-subheader>
        <div v-for="(g, gi) in grouped" :key="g.group">
          <v-divider v-if="gi > 0" class="my-1" />
          <v-list-subheader class="text-uppercase text-caption">
            {{ t("placeholders.groups." + g.group) }}
          </v-list-subheader>
          <v-list-item
            v-for="p in g.items"
            :key="p.token"
            :title="p.insert"
            @click="emit('insert', p.insert)"
          >
            <v-list-item-title class="placeholder-menu__token">
              {{ p.insert }}
            </v-list-item-title>
            <v-list-item-subtitle class="placeholder-menu__desc">
              {{ t("placeholders.tokens." + p.descKey, DATE_EXAMPLE_PARAMS) }}
            </v-list-item-subtitle>
          </v-list-item>
        </div>
      </v-list>
    </v-card>
  </v-menu>
</template>

<style scoped>
.placeholder-menu__token {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8125rem;
}
/* Let the description wrap to full text instead of Vuetify's default one-line
   ellipsis truncation on list-item subtitles. */
.placeholder-menu :deep(.placeholder-menu__desc) {
  -webkit-line-clamp: unset;
  line-clamp: unset;
  white-space: normal;
  overflow: visible;
  display: block;
}
</style>
