/**
 * Enum-code → display-label helpers.
 *
 * Backend enum codes (status/type/payment-method …) are stored/sent as raw
 * snake_case codes. These helpers translate a code to its human label via the
 * `enums.*` i18n block, falling back to a humanized code (snake_case → Title
 * Case) when no translation exists — so a code outside the catalog (e.g. the
 * extra PaymentMethod members `paypal`/`stripe`/`direct_debit`) still renders
 * readably instead of leaking a raw `enums.paymentMethod.paypal` key.
 *
 * Callers pass their own `t` from `useI18n()` so these stay plain functions
 * (usable in both `<script setup>` computed and template contexts).
 */
type TranslateFn = (key: string, ...args: unknown[]) => string;

export const humanizeCode = (code: string): string => {
  return code.replace(/[_-]+/gu, " ").replace(/\b\w/gu, (c) => c.toUpperCase());
};

export const enumLabel = (t: TranslateFn, group: string, code: string | null | undefined): string => {
  if (!code) return "—";
  const key = `enums.${group}.${code}`;
  const translated = t(key);
  return translated === key ? humanizeCode(code) : translated;
};
