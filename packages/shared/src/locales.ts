// -----------------------------------------------------------------------------
// LOCALES — the SINGLE source of truth for every language Billy supports, shared
// by the frontend (UI i18n, dropdowns), the API and the worker (PDF + email
// rendering in the recipient's language). Add a language in ONE place here (plus
// its translation files — see README "Adding a language") and it flows
// everywhere automatically: UI switcher, client-locale dropdown, per-language
// settings editors, and document/email label localization.
// -----------------------------------------------------------------------------

/** One supported language. `code` is the base ISO-639-1 tag used everywhere. */
export interface LocaleInfo {
  /** ISO-639-1 base code, lower-case (e.g. "en", "it"). The canonical key. */
  code: string;
  /** English name, for admin-facing UIs. */
  englishName: string;
  /** Endonym (name in its own language), shown in language pickers. */
  nativeName: string;
}

/**
 * The supported languages, in display order. THIS ARRAY IS THE SOURCE OF TRUTH —
 * to add a language, add an entry here, add its UI catalog + server label table,
 * and it works across the whole app (see README).
 */
export const LOCALES: readonly LocaleInfo[] = [
  { code: "en", englishName: "English", nativeName: "English" },
  { code: "it", englishName: "Italian", nativeName: "Italiano" },
  { code: "es", englishName: "Spanish", nativeName: "Español" },
  { code: "fr", englishName: "French", nativeName: "Français" },
  { code: "de", englishName: "German", nativeName: "Deutsch" },
  { code: "pt", englishName: "Portuguese", nativeName: "Português" },
  { code: "ru", englishName: "Russian", nativeName: "Русский" },
] as const;

/** All supported locale codes (derived — never hand-maintain a second list). */
export const LOCALE_CODES: readonly string[] = LOCALES.map((l) => l.code);

/** The app-wide fallback language when nothing more specific is resolved. */
export const DEFAULT_LOCALE = "en";

/** True iff `code` (base tag) is a supported locale. */
export const isSupportedLocale = (code: string | null | undefined): boolean =>
  code != null && LOCALE_CODES.includes(code.toLowerCase().split(/[-_]/u)[0] ?? "");

/** Normalize any raw tag ("it-IT", "IT", "en_US") to a supported base code, else DEFAULT. */
export const normalizeLocale = (raw: string | null | undefined): string => {
  if (!raw) return DEFAULT_LOCALE;
  const base = raw.toLowerCase().split(/[-_]/u)[0] ?? "";
  return LOCALE_CODES.includes(base) ? base : DEFAULT_LOCALE;
};

/**
 * Full country NAME for an ISO-3166 alpha-2 code, localized to `locale` (e.g.
 * "IT" → "Italy" in en, "Italia" in it). Falls back to the raw code if the
 * runtime lacks Intl.DisplayNames or the code is unknown/blank. Node + browser
 * safe (Intl.DisplayNames is available in both).
 */
export const countryName = (code: string | null | undefined, locale: string = DEFAULT_LOCALE): string => {
  if (!code) return "";
  const cc = code.trim().toUpperCase();
  if (cc.length !== 2) return code; // not an alpha-2 code — leave as-is
  try {
    const dn = new Intl.DisplayNames([normalizeLocale(locale)], { type: "region" });
    return dn.of(cc) ?? cc;
  } catch {
    return cc;
  }
};

/**
 * Resolve the language a DOCUMENT/EMAIL should render in, most-specific first:
 * the client's own locale → the company's default locale → the app default.
 * Each candidate is normalized + validated; unsupported/blank values are skipped.
 */
export const resolveDocumentLocale = (
  clientLocale?: string | null,
  companyLocale?: string | null,
): string => {
  for (const candidate of [clientLocale, companyLocale]) {
    if (candidate && isSupportedLocale(candidate)) return normalizeLocale(candidate);
  }
  return DEFAULT_LOCALE;
};
