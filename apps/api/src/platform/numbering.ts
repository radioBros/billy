import type { Collection } from "mongodb";

/**
 * Document numbering (invoice-numbering / settings numbering). Atomic per-series
 * counters (Q-/INV-/CN-/PRO-) via a `counters` collection — `findOneAndUpdate`
 * `$inc` + upsert is concurrency-safe (no read-then-write race), so numbers are
 * gap-free and never duplicated even under parallel finalize. `formatDocumentNumber`
 * is pure (unit-tested); the sequence step needs Mongo (integration-tested).
 */
export interface Counter {
  _id: string; // series key, e.g. "acct123:invoice-2026"
  seq: number;
  /** The owning account — stamped so account deletion can purge counters by accountId. */
  accountId: string;
}

/**
 * Allocate the next number in a PER-ACCOUNT series. The series key is namespaced
 * by `accountId` so each account has its own gap-free sequence, and the doc is
 * stamped with `accountId` so account deletion can purge it. Concurrency-safe
 * ($inc + upsert).
 */
export const nextSequence = async (
  counters: Collection<Counter>,
  accountId: string,
  seriesKey: string,
): Promise<number> => {
  const scopedKey = `${accountId}:${seriesKey}`;
  const result = await counters.findOneAndUpdate(
    { _id: scopedKey },
    { $inc: { seq: 1 }, $setOnInsert: { accountId } },
    { upsert: true, returnDocument: "after" },
  );
  return result?.seq ?? 1;
};

export interface NumberFormat {
  prefix: string; // "INV", "Q", "CN", "PRO"
  seq: number;
  padding: number; // e.g. 4 → 0001
  year?: number; // optional year segment
  separator?: string; // default "-"
  /**
   * Number layout:
   *   - "prefixed" (default): `PREFIX-YEAR-0001` (padded, hyphen-joined).
   *   - "slashYear": `20/2026` — bare sequence, no prefix, no zero-pad, `/`-joined
   *     with the year. The doc-type word ("Invoice no.") is added by the DISPLAY
   *     layer (i18n), never stored, so the stored number stays type-neutral.
   */
  style?: "prefixed" | "slashYear";
}

export const formatDocumentNumber = (fmt: NumberFormat): string => {
  if (fmt.style === "slashYear") {
    return fmt.year != null ? `${fmt.seq}/${fmt.year}` : String(fmt.seq);
  }
  const sep = fmt.separator ?? "-";
  const num = String(fmt.seq).padStart(fmt.padding, "0");
  return fmt.year != null ? `${fmt.prefix}${sep}${fmt.year}${sep}${num}` : `${fmt.prefix}${sep}${num}`;
};
