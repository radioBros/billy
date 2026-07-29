<script setup lang="ts" generic="T extends Record<string, unknown>">
// =========================================================================
// ServerTable — reusable server-paginated + virtually-scrolled table.
//
// Architecture:
//   • v-data-table-virtual  → virtual-scroll within the current page's rows
//     (no DOM thrash for large pages; client-side sort within page)
//   • TableFooter           → pagination controls wired to parent state
//   • Toolbar row           → search field (left) + ColManager (right)
//
// Parent owns ALL state: page, ipp, total, sortBy, search.
// Use v-model:page, v-model:ipp, v-model:sort-by, v-model:search.
// Pass :total from the server response.
//
// Column slots pass through transparently — use the same slot names as
// v-data-table: #item.foo, #header.foo, etc.
// =========================================================================

import { computed, ref, useSlots, watch } from "vue";
import { useI18n } from "vue-i18n";
import ColManager from "@/components/tables/ColManager.vue";
import TableFooter from "@/components/tables/TableFooter.vue";

export interface ServerTableHeader {
  key: string;
  title: string;
  forced?: boolean;
  sortable?: boolean;
  align?: "start" | "center" | "end";
  [key: string]: unknown;
}

const props = withDefaults(defineProps<{
  headers: ServerTableHeader[];
  items: T[];
  total: number;
  page: number;
  ipp: number;
  sortBy: { key: string; order: "asc" | "desc" }[];
  loading?: boolean;
  tableName: string;
  showColManager?: boolean;
  maxHeight?: number;
}>(), {
  showColManager: true,
});

const emit = defineEmits<{
  (e: "update:page", value: number): void;
  (e: "update:ipp", value: number): void;
  (e: "update:sortBy", value: { key: string; order: "asc" | "desc" }[]): void;
  (e: "update:search", value: string): void;
  (e: "click:row", event: unknown, row: { item: unknown }): void;
}>();

// Forward Vuetify's row click (event, { item }) to the parent.
const onRowClick = (event: unknown, row: { item: unknown }): void => {
  emit("click:row", event, row);
};

const { t } = useI18n();

// ---- search (local, debounced, emitted to parent) -------------------------

const searchLocal = ref("");
let _debounce: ReturnType<typeof setTimeout> | null = null;

watch(searchLocal, (val) => {
  if (_debounce) clearTimeout(_debounce);
  _debounce = setTimeout(() => {
    emit("update:page", 1);
    // Vuetify's `clearable` field emits null on clear — normalise to '' so
    // consumers never receive null (and never call .trim() on null).
    emit("update:search", val ?? "");
  }, 320);
});

// ---- column visibility + order -------------------------------------------

const defaultVisible = computed(() => props.headers.map((h) => h.key));
const visibleKeys = ref<string[]>(defaultVisible.value);
// orderedHeaders tracks the current display order (ColManager owns the order
// state; it emits update:headers after dragging or on mount restore).
const orderedHeaders = ref<ServerTableHeader[]>(props.headers);

const visibleHeaders = computed(() =>
  orderedHeaders.value.filter((h) => visibleKeys.value.includes(h.key)),
);

const onHeadersReordered = (next: ServerTableHeader[]) => {
  orderedHeaders.value = next;
};

// Headers can be DYNAMIC (a parent may add/remove columns as data loads — e.g.
// hiding an all-null column). When the SET of header keys changes, reconcile
// the order/visibility state: keep the current order for retained keys, append
// new keys at the end, drop removed ones, and reveal newly-added keys (so a
// freshly-appearing column isn't hidden by stale visibility state). Triggered
// only on a key-set change, so a pure label/locale change is a no-op.
watch(
  () => props.headers.map((h) => h.key).join("|"),
  () => {
    const incoming = props.headers;
    const incomingKeys = new Set(incoming.map((h) => h.key));
    const byKey = new Map(incoming.map((h) => [h.key, h]));
    // Capture the PRIOR header key-set before reassigning — a key that was
    // present before but is missing from visibleKeys was hidden by the user
    // (don't re-reveal it); only GENUINELY-new keys get auto-revealed.
    const prevHeaderKeys = new Set(orderedHeaders.value.map((h) => h.key));
    // Retain prior order for keys that still exist, then append any new ones.
    const retained = orderedHeaders.value
      .filter((h) => incomingKeys.has(h.key))
      .map((h) => byKey.get(h.key)!);
    const retainedKeys = new Set(retained.map((h) => h.key));
    for (const h of incoming) if (!retainedKeys.has(h.key)) retained.push(h);
    orderedHeaders.value = retained;
    // Visibility: keep currently-visible keys that survive, reveal only keys
    // that did not exist in the prior header set (never re-reveal a user-hidden
    // column whose presence merely toggled with the data).
    const survivingVisible = visibleKeys.value.filter((k) => incomingKeys.has(k));
    const newKeys = incoming.map((h) => h.key).filter((k) => !prevHeaderKeys.has(k));
    visibleKeys.value = [...new Set([...survivingVisible, ...newKeys])];
  },
);

// ---- page count (computed locally — no Vuetify slot data needed) ---------

const pageCount = computed(() => Math.max(1, Math.ceil(props.total / props.ipp)));

// from/to are passed to TableFooter which computes them internally — not needed here.

// ---- slot passthrough — only item.* and header.* reach the inner table ----
// Using useSlots() + a computed filter prevents the v-for loop from
// clobbering Vuetify's reserved slots (#top, #loading, #no-data etc.)
const slots = useSlots();
const columnSlots = computed(() =>
  Object.keys(slots).filter((n) => n.startsWith("item.") || n.startsWith("header.")),
);

// ---- virtual scroll height -----------------------------------------------
// Cap the tbody so it doesn't stretch the full list length.
// Virtual scroll keeps only visible rows in the DOM regardless.

// Cap the table at MAX_TABLE_HEIGHT; below that it sizes to its content (rows)
// rather than filling the page. Few rows → short table; many rows → fixed-header
// scroll once content would exceed the cap.
const MAX_TABLE_HEIGHT = 550;

const tableHeight = computed<number | undefined>(() => {
  if (props.maxHeight) return props.maxHeight;
  // Empty: apply NO fixed height so the #no-data slot renders at its natural
  // size. A fixed height here would clamp the empty message into a cramped
  // header-height strip (the bug this avoids).
  if (props.items.length === 0) return undefined;
  // Content height ≈ row*48 + 56 (header), then capped at MAX_TABLE_HEIGHT.
  const rows = Math.min(props.items.length, 100);
  const content = rows * 48 + 56;
  return Math.min(content, MAX_TABLE_HEIGHT);
});
</script>

<template>
  <div class="server-table">
    <!-- Toolbar: plain div, completely outside v-data-table-virtual so the
         v-for slot passthrough below can never touch it. -->
    <div class="server-table__toolbar">
      <v-text-field
        v-model="searchLocal"
        :placeholder="t('tables.search_placeholder')"
        prepend-inner-icon="mdi-magnify"
        density="compact"
        variant="outlined"
        hide-details
        clearable
        class="server-table__search no-validation"
      />
      <v-spacer />
      <slot name="toolbar" />
      <ColManager
        v-if="showColManager"
        v-model="visibleKeys"
        :headers="headers"
        :table-name="tableName"
        @update:headers="onHeadersReordered"
      />
    </div>

    <v-data-table-virtual
      :headers="visibleHeaders"
      :items="items"
      :loading="loading"
      :sort-by="sortBy"
      :height="tableHeight"
      item-value="id"
      style="background: transparent;"
      fixed-header
      hover
      @update:sort-by="emit('update:sortBy', $event)"
      @click:row="onRowClick"
    >
      <template #loading>
        <v-skeleton-loader type="table-row@6" />
      </template>

      <template #no-data>
        <slot name="no-data">
          <div
            class="text-body-medium py-6 text-center"
            style="color: var(--v-billy-text-3);"
          >
            {{ t('tables.no_results') }}
          </div>
        </slot>
      </template>

      <!-- Forward only item.* and header.* slots — never reserved names. -->
      <template
        v-for="name in columnSlots"
        :key="name"
        #[name]="slotData"
      >
        <slot
          :name="name"
          v-bind="slotData ?? {}"
        />
      </template>
    </v-data-table-virtual>

    <!-- Footer -->
    <div class="server-table__footer-wrap">
      <TableFooter
        :page="page"
        :ipp="ipp"
        :total="total"
        :page-count="pageCount"
        @update:page="emit('update:page', $event)"
        @update:ipp="emit('update:ipp', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.server-table {
  display: flex;
  flex-direction: column;
}

.server-table__toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px 6px;
}

.server-table__search {
  max-width: 320px;
  min-width: 175px;
}
</style>
