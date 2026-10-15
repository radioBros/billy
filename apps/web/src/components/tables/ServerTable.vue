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
//
// MOBILE (< 600px, useIsMobile): the table is replaced by a virtual list of
// cards with infinite scroll. Cards are assembled from the SAME #item.<key>
// slots (so formatting/name resolution is shared with the desktop table),
// positioned by the optional `cardLayout` prop (title / subtitle / status chips
// / amount / meta grid). Pages are accumulated here — the parent keeps its
// plain page/ipp contract and is simply asked for `page + 1` when the user
// scrolls near the end. Column manager + paginator are hidden; a bottom sheet
// hosts the #toolbar filters and the sort controls.
// =========================================================================

import { computed, onBeforeUnmount, ref, shallowRef, useSlots, watch } from "vue";
import { useI18n } from "vue-i18n";
import ColManager from "@/components/tables/ColManager.vue";
import TableFooter from "@/components/tables/TableFooter.vue";
import { useIsMobile } from "@/composables/useIsMobile";

export interface ServerTableHeader {
  key: string;
  title: string;
  forced?: boolean;
  sortable?: boolean;
  align?: "start" | "center" | "end";
  [key: string]: unknown;
}

/**
 * Where each column lands on the mobile card. All values are header keys.
 * Omitted → inferred: first column = title, `*status*` columns = chips, first
 * end-aligned column = amount, everything else = meta. `actions` always goes
 * to the card's top-right corner.
 */
export interface ServerTableCardLayout {
  title: string;
  subtitle?: string;
  status?: string[];
  amount?: string;
  /** Small secondary figure under the amount (e.g. amount due). */
  amountCaption?: string;
  meta?: string[];
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
  cardLayout?: ServerTableCardLayout;
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

// =========================================================================
// Mobile card list
// =========================================================================

const isMobile = useIsMobile();

// Entering/leaving the phone layout restarts from page 1: the card list
// accumulates from the top, the table paginates from the top.
watch(isMobile, () => {
  if (props.page !== 1) emit("update:page", 1);
});

// ---- page accumulation ----------------------------------------------------
// Rows arriving for page p replace slot p and drop every page after it, so a
// filter/search/sort reset (page → 1) clears the list, and a refetch of the
// current page after a row action (void/delete) replaces rather than appends.
const loadedPages = shallowRef(new Map<number, T[]>());

watch(
  () => props.items,
  (rows) => {
    const p = props.page;
    const next = new Map<number, T[]>();
    for (const [k, v] of loadedPages.value) if (k < p) next.set(k, v);
    next.set(p, rows);
    loadedPages.value = next;
  },
  { immediate: true },
);

const cardItems = computed<T[]>(() => {
  const seen = new Set<unknown>();
  const out: T[] = [];
  const keys = [...loadedPages.value.keys()].sort((a, b) => a - b);
  for (const k of keys) {
    for (const row of loadedPages.value.get(k) ?? []) {
      const id = (row as Record<string, unknown>).id;
      if (id !== undefined && seen.has(id)) continue;
      if (id !== undefined) seen.add(id);
      out.push(row);
    }
  }
  return out;
});

const highestLoadedPage = computed(() => Math.max(0, ...loadedPages.value.keys()));
const hasMore = computed(() => highestLoadedPage.value < pageCount.value && props.items.length > 0);

// ---- infinite scroll sentinel --------------------------------------------
const sentinelVisible = ref(false);
let observer: IntersectionObserver | null = null;

const sentinelRef = (el: unknown): void => {
  observer?.disconnect();
  observer = null;
  if (!(el instanceof Element) || typeof IntersectionObserver === "undefined") return;
  observer = new IntersectionObserver(
    (entries) => {
      sentinelVisible.value = entries.some((e) => e.isIntersecting);
    },
    { rootMargin: "0px 0px 600px 0px" },
  );
  observer.observe(el);
};
onBeforeUnmount(() => observer?.disconnect());

// Re-evaluated whenever loading settles too, so a short first page that leaves
// the sentinel on screen keeps pulling until the viewport is filled.
watch(
  [sentinelVisible, () => props.loading, hasMore, isMobile],
  () => {
    if (!isMobile.value || !sentinelVisible.value || props.loading || !hasMore.value) return;
    if (highestLoadedPage.value !== props.page) return;
    emit("update:page", props.page + 1);
  },
);

// ---- card layout ------------------------------------------------------------
const headerByKey = computed(() => new Map(props.headers.map((h) => [h.key, h])));

const layout = computed<Required<ServerTableCardLayout>>(() => {
  const keys = props.headers.map((h) => h.key).filter((k) => k !== "actions");
  const has = (k?: string): k is string => !!k && keys.includes(k);
  const l = props.cardLayout;
  if (l) {
    const used = new Set([l.title, l.subtitle, l.amount, l.amountCaption, ...(l.status ?? [])]);
    return {
      title: l.title,
      subtitle: has(l.subtitle) ? l.subtitle : "",
      status: (l.status ?? []).filter(has),
      amount: has(l.amount) ? l.amount : "",
      amountCaption: has(l.amountCaption) ? l.amountCaption : "",
      meta: (l.meta ?? keys.filter((k) => !used.has(k))).filter(has),
    };
  }
  const title = keys[0] ?? "";
  const status = keys.filter((k) => /status/i.test(k) && k !== title);
  const amount = props.headers.find((h) => h.align === "end" && h.key !== "actions")?.key ?? "";
  return {
    title,
    subtitle: "",
    status,
    amount,
    amountCaption: "",
    meta: keys.filter((k) => k !== title && k !== amount && !status.includes(k)),
  };
});

/** A page-provided cell slot wins outright — even when it renders nothing (Vue
 *  would otherwise show the fallback, e.g. a raw id or a stray dash). */
const hasCellSlot = (key: string): boolean => !!slots[`item.${key}`];

const hasActions = computed(() => props.headers.some((h) => h.key === "actions"));
const labelOf = (key: string): string => headerByKey.value.get(key)?.title ?? key;
/** Same shape as v-data-table's item slot props, plus `card: true` so a page
 *  can tweak a cell for the phone card (e.g. drop an empty-value dash). */
const slotProps = (item: T, key: string, index: number) => ({
  item,
  value: (item as Record<string, unknown>)[key],
  index,
  column: headerByKey.value.get(key),
  card: true,
});
const rawValue = (item: T, key: string): string => {
  const v = (item as Record<string, unknown>)[key];
  return v === null || v === undefined || v === "" ? "\u2014" : String(v);
};

/** Renderless VVirtualScroll hands each item an `itemRef` to bind for height
 *  measurement; its slot type is a union, so read it defensively. */
const itemRefOf = (scope: unknown): any => (scope as { itemRef?: unknown }).itemRef;

const hasValue = (item: T, key: string): boolean => {
  const v = (item as Record<string, unknown>)[key];
  return v !== null && v !== undefined && v !== "";
};

const onCardClick = (event: unknown, item: T): void => {
  emit("click:row", event, { item });
};

// ---- filters + sort sheet ---------------------------------------------------
const sheetOpen = ref(false);
const sortableHeaders = computed(() => props.headers.filter((h) => h.sortable && h.title));
const currentSort = computed(() => props.sortBy[0] ?? null);

const setSort = (key: string): void => {
  const cur = currentSort.value;
  const order: "asc" | "desc" = cur?.key === key ? (cur.order === "asc" ? "desc" : "asc") : "desc";
  emit("update:sortBy", [{ key, order }]);
  emit("update:page", 1);
};
</script>

<template>
  <div v-if="isMobile" class="server-table server-table--mobile">
    <!-- Mobile toolbar: full-width search + a filter/sort sheet trigger. -->
    <div class="st-m__toolbar">
      <v-text-field
        v-model="searchLocal"
        :placeholder="t('tables.search_placeholder')"
        prepend-inner-icon="mdi-magnify"
        density="compact"
        variant="solo-filled"
        flat
        rounded="xl"
        hide-details
        clearable
        class="st-m__search no-validation"
      />
      <v-btn
        icon
        variant="tonal"
        color="primary"
        class="st-m__filter-btn px-0"
        :aria-label="t('tables.filters')"
        @click="sheetOpen = true"
      >
        <v-icon icon="mdi-tune-variant" />
      </v-btn>
    </div>

    <div class="st-m__count">
      <span>{{ t('tables.resultsCount', { n: total }, total) }}</span>
      <span v-if="currentSort && headerByKey.get(currentSort.key)" class="st-m__sort-hint">
        <v-icon :icon="currentSort.order === 'asc' ? 'mdi-arrow-up' : 'mdi-arrow-down'" size="14" />
        {{ labelOf(currentSort.key) }}
      </span>
    </div>

    <!-- First load: skeleton cards. -->
    <div v-if="loading && cardItems.length === 0" class="st-m__list">
      <div v-for="n in 5" :key="n" class="st-card st-card--skeleton">
        <v-skeleton-loader type="list-item-two-line" />
      </div>
    </div>

    <div v-else-if="cardItems.length === 0" class="st-m__empty">
      <slot name="no-data">
        <div class="text-body-medium py-6 text-center" style="color: var(--v-billy-text-3);">
          {{ t('tables.no_results') }}
        </div>
      </slot>
    </div>

    <div v-else class="st-m__list">
      <v-virtual-scroll :items="cardItems" renderless :item-height="132">
        <template #default="scope">
          <!-- renderless mode: each item must bind the itemRef Vuetify measures. -->
          <div :ref="itemRefOf(scope)" class="st-card__slot">
            <div
              class="st-card"
              role="button"
              tabindex="0"
              @click="onCardClick($event, scope.item)"
              @keydown.enter="onCardClick($event, scope.item)"
            >
              <div class="st-card__head">
                <div class="st-card__titles">
                  <div class="st-card__title">
                    <slot v-if="hasCellSlot(layout.title)" :name="`item.${layout.title}`" v-bind="slotProps(scope.item, layout.title, scope.index)" />
                    <template v-else>{{ rawValue(scope.item, layout.title) }}</template>
                  </div>
                  <div v-if="layout.subtitle" class="st-card__subtitle">
                    <slot v-if="hasCellSlot(layout.subtitle)" :name="`item.${layout.subtitle}`" v-bind="slotProps(scope.item, layout.subtitle, scope.index)" />
                    <template v-else>{{ rawValue(scope.item, layout.subtitle) }}</template>
                  </div>
                </div>
                <div v-if="hasActions" class="st-card__actions" @click.stop>
                  <slot name="item.actions" v-bind="slotProps(scope.item, 'actions', scope.index)" />
                </div>
              </div>

              <div v-if="layout.status.length || layout.amount" class="st-card__mid">
                <div class="st-card__chips">
                  <template v-for="key in layout.status" :key="key">
                    <slot v-if="hasCellSlot(key)" :name="`item.${key}`" v-bind="slotProps(scope.item, key, scope.index)" />
                    <template v-else><span class="st-card__plain">{{ rawValue(scope.item, key) }}</span></template>
                  </template>
                </div>
                <div v-if="layout.amount" class="st-card__amount">
                  <div class="st-card__amount-main">
                    <slot v-if="hasCellSlot(layout.amount)" :name="`item.${layout.amount}`" v-bind="slotProps(scope.item, layout.amount, scope.index)" />
                    <template v-else>{{ rawValue(scope.item, layout.amount) }}</template>
                  </div>
                  <div v-if="layout.amountCaption && hasValue(scope.item, layout.amountCaption)" class="st-card__amount-caption">
                    {{ labelOf(layout.amountCaption) }}
                    <slot v-if="hasCellSlot(layout.amountCaption)" :name="`item.${layout.amountCaption}`" v-bind="slotProps(scope.item, layout.amountCaption, scope.index)" />
                    <template v-else>{{ rawValue(scope.item, layout.amountCaption) }}</template>
                  </div>
                </div>
              </div>

              <div v-if="layout.meta.length" class="st-card__meta">
                <div v-for="key in layout.meta" :key="key" class="st-card__meta-scope.item">
                  <div class="st-card__meta-label">{{ labelOf(key) }}</div>
                  <div class="st-card__meta-value">
                    <slot v-if="hasCellSlot(key)" :name="`item.${key}`" v-bind="slotProps(scope.item, key, scope.index)" />
                    <template v-else>{{ rawValue(scope.item, key) }}</template>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
      </v-virtual-scroll>
    </div>

    <!-- Infinite-scroll sentinel + loading-more indicator. -->
    <div :ref="sentinelRef" class="st-m__sentinel" aria-hidden="true" />
    <div v-if="loading && cardItems.length > 0" class="st-m__more">
      <v-progress-circular indeterminate size="22" width="2" color="primary" />
    </div>
    <div v-else-if="!hasMore && cardItems.length > 0" class="st-m__end">
      {{ t('tables.endOfList') }}
    </div>

    <!-- Filters + sort sheet. -->
    <v-bottom-sheet v-model="sheetOpen" inset>
      <v-card class="st-m__sheet" rounded="t-xl">
        <div class="st-m__sheet-grip" />
        <v-card-title class="auto-h st-m__sheet-title">
          <v-icon icon="mdi-tune-variant" class="mr-2" size="20" color="primary" />
          {{ t('tables.filters') }}
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" size="small" class="px-0" :aria-label="t('common.close')" @click="sheetOpen = false" />
        </v-card-title>
        <div class="st-m__sheet-body">
          <div v-if="$slots.toolbar" class="st-m__filters">
            <slot name="toolbar" />
          </div>
          <template v-if="sortableHeaders.length">
            <div class="st-m__sheet-label">{{ t('tables.sortBy') }}</div>
            <div class="st-m__sort-chips">
              <v-chip
                v-for="h in sortableHeaders"
                :key="h.key"
                :color="currentSort?.key === h.key ? 'primary' : undefined"
                :variant="currentSort?.key === h.key ? 'flat' : 'tonal'"
                size="default"
                @click="setSort(h.key)"
              >
                {{ h.title }}
                <v-icon
                  v-if="currentSort?.key === h.key"
                  end
                  :icon="currentSort.order === 'asc' ? 'mdi-arrow-up' : 'mdi-arrow-down'"
                  size="16"
                />
              </v-chip>
            </div>
          </template>
          <v-btn block color="primary" variant="flat" class="mt-5" @click="sheetOpen = false">
            {{ t('tables.showResults', { n: total }, total) }}
          </v-btn>
        </div>
      </v-card>
    </v-bottom-sheet>
  </div>

  <div v-else class="server-table">
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
/* ── Mobile card list ─────────────────────────────────────────────────── */
.st-m__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.st-m__search {
  flex: 1 1 auto;
  min-width: 0;
}
.st-m__filter-btn {
  flex: 0 0 auto;
  width: 44px !important;
  height: 44px !important;
  min-width: 0 !important;
}
.st-m__count {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 4px 10px;
  font-size: 0.8125rem;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.6));
}
.st-m__sort-hint {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.st-m__list {
  display: flex;
  flex-direction: column;
}
.st-card__slot {
  padding-bottom: 10px;
}
.st-card {
  display: block;
  background: rgb(var(--v-theme-surface));
  border: 1px solid var(--v-billy-border, #e2e4e9);
  border-radius: 16px;
  padding: 14px 14px 12px 16px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background-color var(--billy-dur-fast, 150ms) ease, transform var(--billy-dur-fast, 150ms) ease;
}
.st-card:active {
  background: rgba(var(--v-theme-primary), 0.05);
  transform: scale(0.99);
}
.st-card:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
.st-card--skeleton {
  padding: 4px;
  margin-bottom: 10px;
  cursor: default;
}
.st-card__head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.st-card__titles {
  flex: 1 1 auto;
  min-width: 0;
}
.st-card__title {
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}
.st-card__subtitle {
  margin-top: 2px;
  font-size: 0.875rem;
  line-height: 1.35;
  color: var(--v-billy-text-2, rgba(var(--v-theme-on-surface), 0.75));
  overflow-wrap: anywhere;
}
.st-card__actions {
  flex: 0 0 auto;
  margin: -6px -8px 0 0;
}
.st-card__mid {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
}
.st-card__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.st-card__plain {
  font-size: 0.8125rem;
}
.st-card__amount {
  flex: 0 0 auto;
  text-align: right;
  margin-left: auto;
}
.st-card__amount-main {
  font-size: 1.0625rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  white-space: nowrap;
}
.st-card__amount-caption {
  font-size: 0.75rem;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.6));
  white-space: nowrap;
}
.st-card__meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--v-billy-border, #e2e4e9);
}
.st-card__meta-label {
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.55));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.st-card__meta-value {
  font-size: 0.875rem;
  line-height: 1.35;
  overflow-wrap: anywhere;
  min-width: 0;
}
.st-m__sentinel {
  height: 1px;
}
.st-m__more,
.st-m__end {
  display: flex;
  justify-content: center;
  padding: 12px 0 20px;
  font-size: 0.8125rem;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.55));
}
.st-m__empty {
  background: rgb(var(--v-theme-surface));
  border: 1px solid var(--v-billy-border, #e2e4e9);
  border-radius: 16px;
}
.st-m__sheet {
  padding-bottom: env(safe-area-inset-bottom);
}
.st-m__sheet-grip {
  width: 40px;
  height: 4px;
  border-radius: 2px;
  margin: 8px auto 0;
  background: rgba(var(--v-theme-on-surface), 0.2);
}
.st-m__sheet-title {
  display: flex;
  align-items: center;
  background: transparent !important;
  min-height: 0 !important;
  padding: 8px 12px 4px 20px;
}
.st-m__sheet-body {
  padding: 8px 20px 20px;
  max-height: 75vh;
  overflow-y: auto;
}
.st-m__filters {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
}
/* Filter widgets were sized for a toolbar row — let them fill the sheet. */
.st-m__filters :deep(.v-input) {
  max-width: none !important;
  width: 100%;
  margin-left: 0 !important;
}
.st-m__sheet-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.6));
  margin-bottom: 8px;
}
.st-m__sort-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

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
