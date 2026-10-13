/**
 * Labels for the FatturaPA code lists. The codes themselves come from the
 * browser-safe `@billy/einvoice/codes` subpath (NEVER the package barrel, which
 * pulls node:crypto); the human labels live in the locale catalogs under
 * `einvoicing.codes.<list>.<code>`. Natura codes contain a dot ("N2.2"), which
 * vue-i18n resolves as a nested path, so the catalogs nest them: natura.N2.2.
 */
import {
  NATURA_CODES,
  PAYMENT_CONDITIONS,
  PAYMENT_METHODS,
  TAX_REGIMES,
} from "@billy/einvoice/codes";

type TranslateFn = (key: string, ...args: unknown[]) => string;

export type CodeList = "taxRegime" | "paymentMethod" | "paymentCondition" | "natura";

const LISTS: Record<CodeList, readonly string[]> = {
  taxRegime: TAX_REGIMES,
  paymentMethod: PAYMENT_METHODS,
  paymentCondition: PAYMENT_CONDITIONS,
  natura: NATURA_CODES,
};

/** "RF19 — Regime forfettario"; falls back to the bare code when untranslated. */
export const codeLabel = (t: TranslateFn, list: CodeList, code: string): string => {
  const key = `einvoicing.codes.${list}.${code}`;
  const label = t(key);
  return label === key ? code : `${code} — ${label}`;
};

/** v-select items for one code list. */
export const codeItems = (t: TranslateFn, list: CodeList): { title: string; value: string }[] =>
  LISTS[list].map((code) => ({ title: codeLabel(t, list, code), value: code }));
