/**
 * useClientNames — shared, session-lived id → displayName cache so list pages
 * can render a Customer column without joining server-side. Pages call
 * `resolve(ids)` after each fetch (one batched `GET /v1/clients?id[in]=…` per
 * page of unseen ids, archived included since documents may reference archived
 * clients) and bind cells to `nameOf(id)`. Finalized documents should prefer
 * their embedded `clientSnapshot.displayName` and fall back to this cache.
 */
import { reactive } from "vue";
import { api } from "@/api/client";
import type { Client } from "@/types/domain";

const cache = reactive(new Map<string, string>());

/** One /v1/clients call resolves at most this many ids (list grammar cap). */
const BATCH = 200;

export interface UseClientNames {
  /** Fetch (and memoize) the names for any not-yet-cached ids. */
  resolve: (ids: ReadonlyArray<string | null | undefined>) => Promise<void>;
  /** Cached name for an id; null while unresolved (render an em dash). */
  nameOf: (id?: string | null) => string | null;
}

export const useClientNames = (): UseClientNames => {
  const resolve = async (ids: ReadonlyArray<string | null | undefined>): Promise<void> => {
    const missing = [...new Set(ids.filter((v): v is string => typeof v === "string" && v.length > 0))].filter(
      (id) => !cache.has(id),
    );
    for (let i = 0; i < missing.length; i += BATCH) {
      const chunk = missing.slice(i, i + BATCH);
      try {
        const result = await api.list<Client>("/v1/clients", {
          "id[in]": chunk.join(","),
          limit: chunk.length,
          archived: "all",
        });
        for (const c of result.data) cache.set(c.id, c.displayName);
      } catch {
        // Non-fatal: cells stay an em dash; the next page fetch retries.
        return;
      }
      // Ids the server didn't return (soft-deleted client) — cache the miss so
      // we don't re-query them on every page render.
      for (const id of chunk) if (!cache.has(id)) cache.set(id, "—");
    }
  };

  const nameOf = (id?: string | null): string | null => (id ? (cache.get(id) ?? null) : null);

  return { resolve, nameOf };
};
