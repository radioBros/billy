/**
 * vue-i18n plugin (v11 — Composition API mode: `legacy: false`, `useI18n()`).
 *
 * `en` is the base catalog; `es` is a scaffold locale (representative subset).
 * Full extraction across every page is a follow-up (see locales/README.md).
 *
 * `numberFormats` / `datetimeFormats` let `n()` / `d()` honor the active locale.
 * The money util (`@/utils/money`) keeps its own `Intl` currency formatting and is
 * NOT routed through i18n (it is unit-tested and authoritative for money display).
 */
import { createI18n } from "vue-i18n";
import en from "@/locales/en.json";
import es from "@/locales/es.json";
import it from "@/locales/it.json";
import fr from "@/locales/fr.json";
import ru from "@/locales/ru.json";
import pt from "@/locales/pt.json";
import de from "@/locales/de.json";

export const SUPPORTED_LOCALES = ["en", "es", "it", "fr", "ru", "pt", "de"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = "en";

export const normalizeLocale = (raw: string | null | undefined): SupportedLocale => {
  if (!raw) return DEFAULT_LOCALE;
  const base = raw.toLowerCase().split(/[-_]/u)[0];
  return (SUPPORTED_LOCALES as readonly string[]).includes(base ?? "")
    ? (base as SupportedLocale)
    : DEFAULT_LOCALE;
};

const numberFormats = {
  en: {
    decimal: { style: "decimal", minimumFractionDigits: 2, maximumFractionDigits: 2 },
    percent: { style: "percent", maximumFractionDigits: 1 },
  },
  es: {
    decimal: { style: "decimal", minimumFractionDigits: 2, maximumFractionDigits: 2 },
    percent: { style: "percent", maximumFractionDigits: 1 },
  },
  it: {
    decimal: { style: "decimal", minimumFractionDigits: 2, maximumFractionDigits: 2 },
    percent: { style: "percent", maximumFractionDigits: 1 },
  },
  fr: {
    decimal: { style: "decimal", minimumFractionDigits: 2, maximumFractionDigits: 2 },
    percent: { style: "percent", maximumFractionDigits: 1 },
  },
  ru: {
    decimal: { style: "decimal", minimumFractionDigits: 2, maximumFractionDigits: 2 },
    percent: { style: "percent", maximumFractionDigits: 1 },
  },
  pt: {
    decimal: { style: "decimal", minimumFractionDigits: 2, maximumFractionDigits: 2 },
    percent: { style: "percent", maximumFractionDigits: 1 },
  },
  de: {
    decimal: { style: "decimal", minimumFractionDigits: 2, maximumFractionDigits: 2 },
    percent: { style: "percent", maximumFractionDigits: 1 },
  },
} as const;

const datetimeFormats = {
  en: {
    short: { year: "numeric", month: "short", day: "numeric" },
    long: { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" },
  },
  es: {
    short: { year: "numeric", month: "short", day: "numeric" },
    long: { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" },
  },
  it: {
    short: { year: "numeric", month: "short", day: "numeric" },
    long: { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" },
  },
  fr: {
    short: { year: "numeric", month: "short", day: "numeric" },
    long: { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" },
  },
  ru: {
    short: { year: "numeric", month: "short", day: "numeric" },
    long: { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" },
  },
  pt: {
    short: { year: "numeric", month: "short", day: "numeric" },
    long: { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" },
  },
  de: {
    short: { year: "numeric", month: "short", day: "numeric" },
    long: { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" },
  },
} as const;

export const i18n = createI18n({
  legacy: false,
  locale: DEFAULT_LOCALE,
  fallbackLocale: DEFAULT_LOCALE,
  messages: { en, es, it, fr, ru, pt, de },
  numberFormats,
  datetimeFormats,
});

export const setI18nLocale = (locale: SupportedLocale): void => {
  i18n.global.locale.value = locale;
};
