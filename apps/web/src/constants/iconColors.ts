/**
 * iconColors — a small, shared palette mapping nav entries and document actions
 * to a distinct, stable icon colour. DRY: consumed by both the sidebar
 * (AppShell) and the document controls (DocumentActions + RowActionMenu) so the
 * same action always wears the same colour everywhere.
 *
 * Colours are Vuetify theme tokens (`primary`/`info`/`success`/`warning`/`error`)
 * or mid-tone Material colour names (`teal`, `purple`, `indigo`, `cyan`, `pink`,
 * `green`, `amber`). We deliberately avoid `-darken-N`/`-lighten-N` suffixes:
 * those are fixed shades, whereas these names/tokens stay legible against BOTH
 * the light and dark theme backgrounds. Colour lands on icons only — labels keep
 * their default emphasis for readability.
 */

/** Nav entry `titleKey` → icon colour (sidebar). */
export const NAV_ICON_COLORS: Record<string, string> = {
  "nav.dashboard": "primary",
  "nav.clients": "green",
  "nav.documents": "blue",
  "nav.invoices": "blue",
  "nav.proforma": "purple",
  "nav.quotes": "teal",
  "nav.creditNotes": "orange",
  "nav.recurring": "indigo",
  // `warning` (a deeper amber/orange theme token) rather than raw `amber`
  // (#FFC107), which is too light to read on the light-theme card background.
  "nav.expenses": "warning",
  "nav.contracts": "cyan",
  "nav.timeEntries": "pink",
  "nav.subscriptions": "deep-purple",
  "nav.settings": "grey",
};

/** Document-action key → icon colour (DocumentActions buttons + RowActionMenu). */
export const ACTION_ICON_COLORS: Record<string, string> = {
  preview: "info",
  print: "indigo",
  download: "success",
  clone: "purple",
  open: "primary",
  edit: "primary",
  convert: "teal",
  void: "error",
  delete: "error",
};

/** Fallback icon colour for a nav entry with no explicit mapping. */
export const NAV_ICON_FALLBACK = "primary";

export const navIconColor = (titleKey: string): string => {
  return NAV_ICON_COLORS[titleKey] ?? NAV_ICON_FALLBACK;
};

export const actionIconColor = (key: string, tone?: "error" | "warning" | null): string | undefined => {
  if (tone) return tone;
  return ACTION_ICON_COLORS[key];
};
