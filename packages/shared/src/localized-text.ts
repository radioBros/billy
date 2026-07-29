// -----------------------------------------------------------------------------
// LOCALIZED FREE-TEXT — company-authored prose (document notes, header/footer,
// email header/footer, per-doc footers) that can be written PER LANGUAGE so a
// client receives it in their own language. Unlike the structural doc-labels
// (system-owned, fully translated in doc-labels.ts), this is author content, so
// the company fills in whichever languages it wants.
//
// Storage is deliberately BACKWARD-COMPATIBLE: a field is EITHER a plain string
// (legacy / single-language value) OR a `{ [localeCode]: string }` map. The
// tolerant `resolveLocalized` read means old string data keeps rendering with no
// migration — a plain string is treated as the value for every language.
// -----------------------------------------------------------------------------

import { DEFAULT_LOCALE, normalizeLocale } from "./locales.js";

/** A free-text field: a single string (legacy/all-languages) or a per-locale map. */
export type LocalizedText = string | Record<string, string> | null | undefined;

/** True for the per-locale map form (vs a plain string / null). */
export const isLocalizedMap = (v: LocalizedText): v is Record<string, string> =>
  v != null && typeof v === "object";

/**
 * Resolve a localized free-text field to a single string for `locale`.
 *   - plain string  → returned as-is (legacy value applies to every language).
 *   - map           → `map[locale]` → `map[companyDefault]` → `map[DEFAULT_LOCALE]`
 *                     → the first non-empty entry → "".
 * `companyDefault` is the account's default language (the middle fallback tier).
 */
export const resolveLocalized = (
  field: LocalizedText,
  locale: string,
  companyDefault?: string | null,
): string => {
  if (field == null) return "";
  if (typeof field === "string") return field;
  const want = normalizeLocale(locale);
  const fallback = companyDefault ? normalizeLocale(companyDefault) : DEFAULT_LOCALE;
  const pick =
    nonEmpty(field[want]) ??
    nonEmpty(field[fallback]) ??
    nonEmpty(field[DEFAULT_LOCALE]) ??
    firstNonEmpty(field);
  return pick ?? "";
};

const nonEmpty = (s: string | undefined): string | undefined =>
  s != null && s.trim().length > 0 ? s : undefined;

const firstNonEmpty = (map: Record<string, string>): string | undefined => {
  for (const v of Object.values(map)) {
    const t = nonEmpty(v);
    if (t) return t;
  }
  return undefined;
};

/**
 * Normalize any stored value into a per-locale map for EDITING in the UI (so the
 * editor always works with a map). A legacy plain string becomes the value under
 * `seedLocale` (default: the app default), letting the admin then diverge other
 * languages from it.
 */
export const toLocalizedMap = (
  field: LocalizedText,
  seedLocale: string = DEFAULT_LOCALE,
): Record<string, string> => {
  if (isLocalizedMap(field)) return { ...field };
  if (typeof field === "string" && field.length > 0) return { [normalizeLocale(seedLocale)]: field };
  return {};
};
