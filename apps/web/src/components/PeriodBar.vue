<script setup lang="ts">
/**
 * PeriodBar — a reusable, Fatture-in-Cloud-style month strip that sits at the top
 * of a list page (or the dashboard). For the GLOBAL year (from the period store)
 * it shows one cell per month with that month's document COUNT and € TOTAL, and
 * lets the user select one/several months (or "All year") to filter the view
 * below. The selected months are exposed via `v-model:months` (empty ⇒ all).
 *
 * It self-fetches its data from GET /v1/dashboard/monthly-totals?kind&year using
 * the `kind` prop, and re-fetches whenever the global year changes. Money totals
 * are financial-gated server-side (counts always present); when several
 * currencies appear in a month the cell shows the dominant one with a "+N" hint,
 * because a list page is single-currency in practice.
 *
 * Nicer-than-Fatture touches: rounded cells, a clear active state with an accent
 * underline, a live "selected months" summary, horizontal scroll (never wraps
 * awkwardly) on narrow screens, and a single "All year" toggle instead of a
 * separate button column.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import { minorToDisplay } from "@/utils/money";
import { usePeriodStore } from "@/stores/period";
import { MONTH_ABBR } from "@/components/dashboard/types";

interface MonthlyTotalsPoint {
  month: string;
  monthNumber: number;
  count: number;
  totals: Record<string, number>;
}

const props = defineProps<{
  /** Which list collection to fetch month totals for (invoices, quotes, …). */
  kind: string;
}>();

/** Selected 1-based month numbers; empty ⇒ ALL months (whole year). */
const months = defineModel<number[]>("months", { default: () => [] });

const { t } = useI18n();
const period = usePeriodStore();

const rows = ref<MonthlyTotalsPoint[]>([]);
const loading = ref(false);
const errorMessage = ref<string | null>(null);

let requestSeq = 0;

const load = async (): Promise<void> => {
  const seq = ++requestSeq;
  loading.value = true;
  errorMessage.value = null;
  try {
    const data = await api.get<MonthlyTotalsPoint[]>("/v1/dashboard/monthly-totals", {
      kind: props.kind,
      year: period.year,
    });
    if (seq !== requestSeq) return;
    rows.value = Array.isArray(data) ? data : [];
  } catch (err) {
    if (seq !== requestSeq) return;
    rows.value = [];
    errorMessage.value = err instanceof ApiError ? t("period.loadError") : t("period.loadError");
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
};

// Year changes globally → reset the month selection (months are year-scoped) and
// re-fetch. Also fetch immediately on mount / when kind changes.
watch(
  () => [period.year, props.kind],
  () => {
    months.value = [];
    void load();
  },
  { immediate: true },
);

const allSelected = computed<boolean>(() => months.value.length === 0);

const selectAll = (): void => {
  months.value = [];
};

// ── Click-drag "paint" selection ──────────────────────────────────────────────
// Press a month and drag across others to select/deselect a run; a plain
// press+release on one cell is a toggle.
const dragging = ref(false);
// The paint mode fixed at drag start: true ⇒ selecting, false ⇒ deselecting.
const paintSelect = ref(true);

const isSelected = (n: number): boolean => allSelected.value || months.value.includes(n);

/** Apply the current paint mode to month `n` (idempotent within a drag). */
const paint = (n: number): void => {
  const has = months.value.includes(n);
  if (paintSelect.value && !has) months.value = [...months.value, n].sort((a, b) => a - b);
  else if (!paintSelect.value && has) months.value = months.value.filter((m) => m !== n);
};

const endDrag = (): void => {
  dragging.value = false;
  window.removeEventListener("pointerup", endDrag);
};

const onCellPointerDown = (n: number): void => {
  dragging.value = true;
  if (allSelected.value) {
    // From "all year", start a fresh selection of just this month.
    paintSelect.value = true;
    months.value = [n];
  } else {
    // Mode decided by the first cell: ON ⇒ deselect the run, else select it.
    paintSelect.value = !months.value.includes(n);
    paint(n);
  }
  window.addEventListener("pointerup", endDrag);
};

const onCellPointerEnter = (n: number): void => {
  if (dragging.value) paint(n);
};

/** The dominant currency's total for a month + a hint of any extra currencies. */
const cellMoney = (row: MonthlyTotalsPoint): { text: string; extra: number } => {
  const entries = Object.entries(row.totals);
  if (entries.length === 0) return { text: minorToDisplay(0, null), extra: 0 };
  entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const [cur, minor] = entries[0]!;
  return { text: minorToDisplay(minor, cur), extra: entries.length - 1 };
};

/**
 * Aggregate for the CURRENT selection (all year, or the picked months): the doc
 * count and the dominant-currency money total — mirrors a month cell's two-line
 * shape (count on top, amount under).
 */
const selectionTotal = computed<{ count: string; money: string }>(() => {
  const sel = new Set(months.value);
  const totals: Record<string, number> = {};
  let count = 0;
  for (const r of rows.value) {
    if (!allSelected.value && !sel.has(r.monthNumber)) continue;
    count += r.count;
    for (const [cur, minor] of Object.entries(r.totals)) totals[cur] = (totals[cur] ?? 0) + minor;
  }
  const entries = Object.entries(totals).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const countText = t("period.docCount", { count }, count);
  const [cur, minor] = entries[0] ?? [null, 0];
  return { count: countText, money: minorToDisplay(minor, cur) };
});

const monthLabel = (n: number): string => MONTH_ABBR[n - 1] ?? String(n);
</script>

<template>
  <v-card variant="flat" border rounded="lg" class="period-bar mb-4">
    <div v-if="errorMessage" class="pa-3 text-caption text-error">{{ errorMessage }}</div>
    <v-progress-linear v-if="loading" indeterminate color="primary" height="2" />

    <div class="period-bar__cells">
      <!-- Month cells: month name above count + € body, coloured rail marks the
           active month(s). Press+drag paints a selection; a click toggles one. -->
      <button
          v-for="row in rows"
          :key="row.monthNumber"
          type="button"
          class="period-cell"
          :class="{ 'period-cell--on': isSelected(row.monthNumber) && !allSelected }"
          :aria-pressed="isSelected(row.monthNumber)"
          @pointerdown.prevent="onCellPointerDown(row.monthNumber)"
          @pointerenter="onCellPointerEnter(row.monthNumber)"
        >
          <span class="period-cell__head">{{ monthLabel(row.monthNumber) }}</span>
          <span class="period-cell__body">
            <span class="period-cell__count">{{ t("period.docCount", { count: row.count }, row.count) }}</span>
            <span class="period-cell__money">
              {{ cellMoney(row).text }}
              <span v-if="cellMoney(row).extra > 0" class="period-cell__extra">+{{ cellMoney(row).extra }}</span>
            </span>
          </span>
          <span class="period-cell__rail" />
        </button>

        <!-- "All year" cell (rightmost, like Fatture's "Seleziona tutto"). -->
        <button
          type="button"
          class="period-cell period-cell--all"
          :class="{ 'period-cell--on': allSelected }"
          :aria-pressed="allSelected"
          @click="selectAll"
        >
          <span class="period-cell__head">{{ t("period.selectAll") }}</span>
          <span class="period-cell__body">
            <span class="period-cell__count">{{ selectionTotal.count }}</span>
            <span class="period-cell__money period-cell__money--all">{{ selectionTotal.money }}</span>
          </span>
          <span class="period-cell__rail" />
        </button>
    </div>
  </v-card>
</template>

<style scoped>
.period-bar {
  overflow: hidden;
}
.period-bar__cells {
  display: flex;
  align-items: stretch;
}
/* Cells share the width equally and shrink to fit, so all 13 always fit. */
.period-cell {
  position: relative;
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 0;
  border-right: 1px solid var(--v-billy-border, rgba(0, 0, 0, 0.08));
  background: transparent;
  cursor: pointer;
  text-align: center;
  transition: background-color 140ms ease;
  /* Drag-to-paint: don't select text or let touch scroll the bar mid-drag. */
  user-select: none;
  touch-action: none;
}
.period-cell:hover {
  background: rgba(var(--v-theme-primary), 0.05);
}
.period-cell__head {
  padding: 7px 6px 5px;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--v-billy-text-2);
  border-bottom: 1px solid var(--v-billy-border, rgba(0, 0, 0, 0.06));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.period-cell__body {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding: 8px 6px 10px;
  /* Fixed body height so the bar NEVER changes height as cell text (esp. the
     All-year total, which grows/shrinks while painting a drag) reflows — a
     changing height was flashing the page's vertical scrollbar mid-drag. */
  min-height: 44px;
}
.period-cell__count {
  font-size: 0.75rem;
  color: var(--v-billy-text-3);
  white-space: nowrap;
}
/* The All-year total uses the same money shape as a month, in success/green to
   set the aggregate apart from the per-month (primary) amounts. */
.period-cell__money--all {
  color: rgb(var(--v-theme-success));
}
.period-cell__money {
  font-size: 0.875rem;
  font-weight: 700;
  color: rgb(var(--v-theme-primary));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.period-cell__extra {
  font-size: 0.625rem;
  font-weight: 600;
  color: var(--v-billy-text-3);
}
/* The active rail: a coloured bar at the bottom edge (Fatture green underline). */
.period-cell__rail {
  height: 3px;
  background: transparent;
  transition: background-color 140ms ease;
}
.period-cell--on {
  background: rgba(var(--v-theme-primary), 0.08);
}
.period-cell--on .period-cell__rail {
  background: rgb(var(--v-theme-success));
}
.period-cell--all {
  flex: 1 1 0;
  min-width: 92px;
  border-right: none;
  border-left: 2px solid var(--v-billy-border, rgba(0, 0, 0, 0.12));
  background: rgba(var(--v-theme-primary), 0.03);
}
.period-cell--all.period-cell--on {
  background: rgba(var(--v-theme-success), 0.1);
}
@media (prefers-reduced-motion: reduce) {
  .period-cell,
  .period-cell__rail {
    transition: none;
  }
}
</style>
