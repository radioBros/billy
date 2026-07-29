/**
 * Global PERIOD store — the app-wide year selection (Fatture-style "Anno 2026"
 * in the top bar). Changing the year re-scopes EVERY page: dashboard KPIs +
 * charts, and each list page's month-bar totals + filtered list.
 *
 * Only the YEAR is global. The MONTH subset is per-page state (a page's month-bar
 * owns its own selection) because "which months am I looking at" is a local view
 * concern, whereas "which fiscal year" is a session-wide context — this mirrors
 * how Fatture in Cloud scopes the year globally but lets each view pick months.
 *
 * The chosen year persists to localStorage so it survives reloads/navigation.
 * The available range (minYear..maxYear) is seeded from GET /v1/dashboard/years
 * once, then clamped so the selection is always valid.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/api/client";

const STORAGE_KEY = "billy.period.year";

const readStoredYear = (): number | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1970 && n <= 9999 ? n : null;
  } catch {
    return null;
  }
};

export const usePeriodStore = defineStore("period", () => {
  const currentYear = new Date().getFullYear();
  const minYear = ref<number>(currentYear);
  const maxYear = ref<number>(currentYear);
  // Restore a previously-chosen year, else default to the current year.
  const year = ref<number>(readStoredYear() ?? currentYear);
  const rangeLoaded = ref<boolean>(false);

  /** The selectable years, newest first (for the top-bar dropdown). */
  const years = computed<number[]>(() => {
    const out: number[] = [];
    for (let y = maxYear.value; y >= minYear.value; y--) out.push(y);
    return out;
  });

  const clampYear = (): void => {
    if (year.value < minYear.value) year.value = minYear.value;
    if (year.value > maxYear.value) year.value = maxYear.value;
  };

  /** Set the active year (persisted). Clamped to the loaded range. */
  function setYear(next: number): void {
    if (!Number.isInteger(next)) return;
    year.value = next;
    clampYear();
    try {
      localStorage.setItem(STORAGE_KEY, String(year.value));
    } catch {
      /* storage unavailable (private mode etc.) — selection still works in-memory */
    }
  }

  /**
   * Load the available-year range once (idempotent). Also ensures the current
   * calendar year is always selectable even before any docs land in it.
   */
  async function loadRange(): Promise<void> {
    if (rangeLoaded.value) return;
    try {
      const data = await api.get<{ minYear: number; maxYear: number }>("/v1/dashboard/years");
      minYear.value = Math.min(data.minYear, currentYear);
      maxYear.value = Math.max(data.maxYear, currentYear);
    } catch {
      minYear.value = currentYear;
      maxYear.value = currentYear;
    } finally {
      rangeLoaded.value = true;
      clampYear();
    }
  }

  return { year, minYear, maxYear, years, rangeLoaded, setYear, loadRange };
});
