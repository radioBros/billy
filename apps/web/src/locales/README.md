# Locales

vue-i18n message catalogs. `en.json` is the **base** (source of truth for keys);
`es.json` is a scaffold locale with a representative subset translated.

## Status: representative slice only

This is the i18n **infrastructure + pattern**, not a full extraction. Only a
representative slice is wired to `t()`:

- The AppShell navigation + top-bar chrome (`nav.*`, `shell.*`, `notifications.*`).
- One full page — the Clients list (`clients.*`) — as the reference pattern.

**Full string extraction across every page is a follow-up mechanical pass.** When
doing it: add keys to `en.json` first, mirror them into `es.json` (and any new
locale), then replace literals with `t('...')` in each page. Keep the nesting flat
and grouped by feature (see existing groups).

## Number / date / currency formatting

`numberFormats` / `datetimeFormats` live in `@/plugins/i18n`, so `n()` / `d()`
honor the active locale. The money util (`@/utils/money`) keeps its own `Intl`
formatting (it is unit-tested and authoritative for minor-unit currency display) —
do **not** route money through i18n; use i18n's `n`/`d` for non-money numbers/dates.

## Locale selection

The active locale is chosen by the locale switcher (app bar) and persisted to
`localStorage` (`billy.locale`), mirroring the theme store. On first load, if no
stored choice exists, the app seeds from the branding `defaultLocale`
(`GET /v1/settings/localization`), normalized to its base subtag (e.g. `en-US` → `en`).
