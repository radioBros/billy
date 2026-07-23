import { LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, type ListWhitelist, type SortSpec } from "@billy/types";
import { errors } from "@billy/shared";

/**
 * Parses the canonical list-query grammar into a Mongo
 * filter/sort, validating every sort/filter field against the resource whitelist
 * so queries stay index-backed. Pure — unit-tested
 * without a DB.
 */

export interface ParsedListQuery {
  filter: Record<string, unknown>;
  sort: Record<string, 1 | -1>;
  sortSpec: SortSpec[];
  page: number;
  limit: number;
  skip: number;
  q?: string;
  archived: "false" | "true" | "all";
}

type RawParams = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string | undefined => {
  return Array.isArray(v) ? v[0] : v;
};

const toInt = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export const parseListQuery = (raw: RawParams, whitelist: ListWhitelist): ParsedListQuery => {
  const page = toInt(first(raw.page), 1);
  const limit = Math.min(toInt(first(raw.limit), LIST_LIMIT_DEFAULT), LIST_LIMIT_MAX);

  // sort — comma list; leading '-' = desc. Every key must be whitelisted.
  const sortSpec: SortSpec[] = [];
  const sortRaw = first(raw.sort);
  if (sortRaw) {
    for (const token of sortRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
      const order: "asc" | "desc" = token.startsWith("-") ? "desc" : "asc";
      const key = token.replace(/^-/, "");
      if (!whitelist.sortable.includes(key)) {
        throw errors.validation(`Unsortable field: ${key}`, { sort: "field_not_sortable" });
      }
      sortSpec.push({ key, order });
    }
  }
  const sort: Record<string, 1 | -1> = {};
  for (const s of sortSpec) sort[s.key] = s.order === "desc" ? -1 : 1;

  // filters — exact, [in], [gte]/[lte], and dateFrom/dateTo shortcut.
  const filter: Record<string, unknown> = {};
  const reserved = new Set(["page", "limit", "sort", "q", "archived", "dateFrom", "dateTo"]);
  for (const [rawKey, rawVal] of Object.entries(raw)) {
    if (reserved.has(rawKey) || rawVal === undefined) continue;
    const m = /^([a-zA-Z0-9_.]+)(?:\[(in|gte|lte)\])?$/.exec(rawKey);
    if (!m) continue;
    const field = m[1] as string;
    const op = m[2];
    if (!whitelist.filterable.includes(field)) {
      throw errors.validation(`Unfilterable field: ${field}`, { [field]: "field_not_filterable" });
    }
    const val = first(rawVal) ?? "";
    if (op === "in") {
      filter[field] = { $in: val.split(",").map((s) => s.trim()) };
    } else if (op === "gte" || op === "lte") {
      const existing = (filter[field] as Record<string, unknown> | undefined) ?? {};
      filter[field] = { ...existing, [`$${op}`]: val };
    } else {
      filter[field] = val;
    }
  }

  // q — case-insensitive match across the resource's searchable fields.
  const q = first(raw.q)?.trim() || undefined;
  if (q && whitelist.searchable.length > 0) {
    const rx = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    filter.$or = whitelist.searchable.map((f) => ({ [f]: rx }));
  }

  const archivedRaw = first(raw.archived);
  const archived = archivedRaw === "true" || archivedRaw === "all" ? archivedRaw : "false";

  return { filter, sort, sortSpec, page, limit, skip: (page - 1) * limit, q, archived };
};
