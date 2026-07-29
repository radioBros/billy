# Localization — implemented & known gaps

## Implemented (this batch)

- **Single source of truth:** `packages/shared/src/locales.ts` (`LOCALES`), consumed
  by UI, settings, PDF and email. See README → "Languages & translations".
- **Numbering:** all sent documents number as `{seq}/{year}` (e.g. `20/2026`);
  rendered as "Invoice no. 20/2026 of DATE" with the label words localized.
- **Client language + referral:** `client.preferredLanguage` (dropdown) drives the
  language of that client's documents & emails; `client.referral` is a contact
  person. Both are frozen into each document's `clientSnapshot` at creation.
- **Document PDFs (invoice, quote, proforma, credit note):** structural labels
  localized to the recipient via `docLabels(resolveDocumentLocale(...))`, resolved
  at the branding-assembly boundary (renderers stay string-typed).
- **Emails (invoice, quote):** subject/body localized to the client's language via
  the existing `EMAIL_I18N` catalog.
- **Company free-text (per-language):** notes/header/footer fields accept
  `string | { [locale]: string }`; edited per language in Settings; resolved via
  `resolveLocalized(field, locale, companyDefault)` (tolerant — legacy plain
  strings keep working, no migration).
- **Language resolution:** `client.preferredLanguage` → company `defaultLocale`
  (Settings → Localization) → `en`.
- **Contracts (by design):** single-language. A contract is authored for one
  client in one language; its PDF renders in the default language and its
  header/footer resolve to the default. Not recipient-localized.

## Known gaps / follow-ups (pre-existing; not regressions)

These settings fields were **already not wired to any renderer** before this
batch. They are now per-language-capable (stored + editable), and `resolveLocalized`
is ready — but a consumer still needs to render them:

- **`emailHeaderHtml` / `emailFooterHtml`** — the email `htmlShell` wrapper
  (`apps/api/src/modules/email/service.ts`) is a bare `<html><body>` and does not
  yet inject a branding header/footer. Wiring requires threading branding through
  the email compose path.
- **`invoiceFooter` / `quoteFooter`** — not consumed by the PDF templates (which
  use `documentFooterHtml`). Decide whether these are redundant with
  `documentFooterHtml` or should render as a per-doc-type footer.

Until wired, editing these four in Settings stores the value (per language) but it
won't appear on the email/document. `documentHeaderHtml` / `documentFooterHtml` /
`contractHeaderHtml` / `contractFooterHtml` ARE rendered and fully localized.
