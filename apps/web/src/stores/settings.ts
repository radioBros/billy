/**
 * useSettingsStore — server-synced per-user UI preferences (table column
 * visibility/order/page-size), the backing for the mandated ServerTable +
 * ColManager.
 *
 * Source of truth: `GET/PATCH /v1/me/settings` → `UserSettings.tables`
 * (settings schema `TablePrefsSchema`: { visibility[], order[], ipp? }). A local
 * copy lives in Pinia so components read without a round-trip; PATCH persists a
 * single table slice fire-and-forget. Cleared on logout.
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import { api } from "@/api/client";

/** Matches the backend `TablePrefsSchema` (per-table, keyed by a stable tableName). */
export interface TableConfig {
  /** Visible column keys. */
  visibility: string[];
  /** Column display order (keys). */
  order: string[];
  /** Preferred rows-per-page. */
  ipp?: number;
}

interface MeSettingsResponse {
  tables?: Record<string, TableConfig>;
}

export const useSettingsStore = defineStore("settings", () => {
  const tables = ref<Record<string, TableConfig>>({});
  const loaded = ref(false);

  /** Load once (idempotent). Non-fatal on failure — falls back to client defaults. */
  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return;
    try {
      const raw = await api.get<MeSettingsResponse>("/v1/me/settings");
      tables.value = raw?.tables ?? {};
    } catch {
      // ignore — local defaults are fine; a member with no prefs yet is normal
    } finally {
      loaded.value = true;
    }
  }

  /** Persist one table's slice (fire-and-forget; local state stays correct on error). */
  function save(tableName: string): void {
    const slice = tables.value[tableName];
    if (!slice) return;
    void api.patch("/v1/me/settings", { tables: { [tableName]: slice } }).catch(() => {
      /* ignore — offline/error; local state already updated */
    });
  }

  function getTable(tableName: string): TableConfig | undefined {
    return tables.value[tableName];
  }

  function setVisibility(tableName: string, keys: string[]): void {
    const prev = tables.value[tableName];
    tables.value[tableName] = { order: prev?.order ?? keys, visibility: keys, ...(prev?.ipp ? { ipp: prev.ipp } : {}) };
    save(tableName);
  }

  function setOrder(tableName: string, keys: string[]): void {
    const prev = tables.value[tableName];
    tables.value[tableName] = { visibility: prev?.visibility ?? keys, order: keys, ...(prev?.ipp ? { ipp: prev.ipp } : {}) };
    save(tableName);
  }

  function setIpp(tableName: string, ipp: number): void {
    const prev = tables.value[tableName];
    tables.value[tableName] = { visibility: prev?.visibility ?? [], order: prev?.order ?? [], ipp };
    save(tableName);
  }

  /** Clear on logout (per-user prefs must not leak across sessions). */
  function reset(): void {
    tables.value = {};
    loaded.value = false;
  }

  return { tables, loaded, load, save, getTable, setVisibility, setOrder, setIpp, reset };
});
