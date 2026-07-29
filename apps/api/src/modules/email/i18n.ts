import type { EmailTemplate } from "@/modules/email/types.js";

/**
 * Email i18n catalog (Billy backend localization — settings LanguageEnum parity).
 *
 * Localizes the 5 transactional templates rendered by {@link EmailService.compose}
 * into all 7 supported locales. The catalog is a pure string table: builders take
 * the already-resolved template variables and return the fixed prose interleaved
 * with those variables. It NEVER escapes — `compose` escapes the HTML-bound vars
 * with `esc()` before handing them to `htmlBody`, and passes RAW vars to `subject`
 * and `textBody` (matching the original html-escaped / text-raw / subject-raw
 * split). Keeping escaping in `compose` means this file stays a plain string map.
 *
 * Structure: `EMAIL_I18N[template][locale] → { subject, htmlBody, textBody }`.
 * Typed as a total `Record<EmailTemplate, Record<SupportedEmailLocale, …>>` so a
 * missing template or locale is a COMPILE error (this replaces the exhaustiveness
 * `never` check the old switch carried). Unknown locale → en fallback is handled
 * at the `compose` lookup, never here.
 */

/** The locales Billy localizes transactional email into (parity with settings LanguageEnum). */
export type SupportedEmailLocale = "en" | "es" | "it" | "fr" | "ru" | "pt" | "de";

/** All supported email locales as a readonly array (iteration/tests). */
export const SUPPORTED_EMAIL_LOCALES: readonly SupportedEmailLocale[] = [
  "en",
  "es",
  "it",
  "fr",
  "ru",
  "pt",
  "de",
] as const;

// ── Per-template variable bags ───────────────────────────────────────────────
// One bag per template. `compose` fills each field with EITHER the escaped value
// (when building `htmlBody`) or the raw value (when building `subject`/`textBody`).
// `link`/`code` are the empty string when absent — builders gate their optional
// fragments on truthiness, preserving the original conditionals.

export interface InvoiceVars {
  number: string;
  amount: string;
  business: string;
  link: string;
}
export interface QuoteVars {
  number: string;
  amount: string;
  business: string;
  link: string;
}
export interface PasswordResetVars {
  link: string;
  expiry: string;
}
export interface EmailVerificationVars {
  link: string;
  code: string;
}
export interface GenericVars {
  body: string;
  link: string;
  actionLabel: string;
}

/** A localized string set for one template. Builders receive the resolved vars. */
interface TemplateStrings<V> {
  /** Subject line (raw vars). */
  subject: (v: V) => string;
  /** HTML body INNER markup (escaped vars) — wrapped in htmlShell by `compose`. */
  htmlBody: (v: V) => string;
  /** Plain-text body (raw vars). */
  textBody: (v: V) => string;
}

/** One locale map per template, each carrying its template's var type. */
type LocaleMap<V> = Record<SupportedEmailLocale, TemplateStrings<V>>;

/**
 * The catalog's type: per-template var bindings. Being a total mapped type over
 * `EmailTemplate` × `SupportedEmailLocale`, a missing template OR locale is a
 * COMPILE error — this is the exhaustiveness guarantee that replaced the switch's
 * `never` check. Also gives the builder arrow params their `V` type (no `any`).
 */
interface EmailCatalog {
  "invoice-sent": LocaleMap<InvoiceVars>;
  "quote-sent": LocaleMap<QuoteVars>;
  "password-reset": LocaleMap<PasswordResetVars>;
  "email-verification": LocaleMap<EmailVerificationVars>;
  "generic-notification": LocaleMap<GenericVars>;
}

// Compile-time assertion that EmailCatalog's keys stay in sync with EmailTemplate.
type _KeysInSync = EmailTemplate extends keyof EmailCatalog
  ? keyof EmailCatalog extends EmailTemplate
    ? true
    : never
  : never;
const _keysInSync: _KeysInSync = true;
void _keysInSync;

export const EMAIL_I18N: EmailCatalog = {
  "invoice-sent": {
    en: {
      subject: (v) => `Invoice ${v.number} from ${v.business}`.trim(),
      htmlBody: (v) =>
        `<p>Hello,</p><p>${v.business} has sent you invoice <strong>${v.number}</strong> for <strong>${v.amount}</strong>.</p>` +
        (v.link ? `<p><a href="${v.link}">View invoice</a></p>` : ""),
      textBody: (v) =>
        `Hello,\n\n${v.business} has sent you invoice ${v.number} for ${v.amount}.` +
        (v.link ? `\n\nView it here: ${v.link}` : "") +
        `\n`,
    },
    es: {
      subject: (v) => `Factura ${v.number} de ${v.business}`.trim(),
      htmlBody: (v) =>
        `<p>Hola,</p><p>${v.business} le ha enviado la factura <strong>${v.number}</strong> por <strong>${v.amount}</strong>.</p>` +
        (v.link ? `<p><a href="${v.link}">Ver factura</a></p>` : ""),
      textBody: (v) =>
        `Hola,\n\n${v.business} le ha enviado la factura ${v.number} por ${v.amount}.` +
        (v.link ? `\n\nVéala aquí: ${v.link}` : "") +
        `\n`,
    },
    it: {
      subject: (v) => `Fattura ${v.number} da ${v.business}`.trim(),
      htmlBody: (v) =>
        `<p>Salve,</p><p>${v.business} le ha inviato la fattura <strong>${v.number}</strong> per <strong>${v.amount}</strong>.</p>` +
        (v.link ? `<p><a href="${v.link}">Visualizza fattura</a></p>` : ""),
      textBody: (v) =>
        `Salve,\n\n${v.business} le ha inviato la fattura ${v.number} per ${v.amount}.` +
        (v.link ? `\n\nVisualizzala qui: ${v.link}` : "") +
        `\n`,
    },
    fr: {
      subject: (v) => `Facture ${v.number} de ${v.business}`.trim(),
      htmlBody: (v) =>
        `<p>Bonjour,</p><p>${v.business} vous a envoyé la facture <strong>${v.number}</strong> d'un montant de <strong>${v.amount}</strong>.</p>` +
        (v.link ? `<p><a href="${v.link}">Voir la facture</a></p>` : ""),
      textBody: (v) =>
        `Bonjour,\n\n${v.business} vous a envoyé la facture ${v.number} d'un montant de ${v.amount}.` +
        (v.link ? `\n\nConsultez-la ici : ${v.link}` : "") +
        `\n`,
    },
    ru: {
      subject: (v) => `Счёт ${v.number} от ${v.business}`.trim(),
      htmlBody: (v) =>
        `<p>Здравствуйте,</p><p>${v.business} направил(а) вам счёт <strong>${v.number}</strong> на сумму <strong>${v.amount}</strong>.</p>` +
        (v.link ? `<p><a href="${v.link}">Посмотреть счёт</a></p>` : ""),
      textBody: (v) =>
        `Здравствуйте,\n\n${v.business} направил(а) вам счёт ${v.number} на сумму ${v.amount}.` +
        (v.link ? `\n\nПосмотреть можно здесь: ${v.link}` : "") +
        `\n`,
    },
    pt: {
      subject: (v) => `Fatura ${v.number} de ${v.business}`.trim(),
      htmlBody: (v) =>
        `<p>Olá,</p><p>${v.business} enviou-lhe a fatura <strong>${v.number}</strong> no valor de <strong>${v.amount}</strong>.</p>` +
        (v.link ? `<p><a href="${v.link}">Ver fatura</a></p>` : ""),
      textBody: (v) =>
        `Olá,\n\n${v.business} enviou-lhe a fatura ${v.number} no valor de ${v.amount}.` +
        (v.link ? `\n\nVeja-a aqui: ${v.link}` : "") +
        `\n`,
    },
    de: {
      subject: (v) => `Rechnung ${v.number} von ${v.business}`.trim(),
      htmlBody: (v) =>
        `<p>Guten Tag,</p><p>${v.business} hat Ihnen die Rechnung <strong>${v.number}</strong> über <strong>${v.amount}</strong> gesendet.</p>` +
        (v.link ? `<p><a href="${v.link}">Rechnung ansehen</a></p>` : ""),
      textBody: (v) =>
        `Guten Tag,\n\n${v.business} hat Ihnen die Rechnung ${v.number} über ${v.amount} gesendet.` +
        (v.link ? `\n\nHier ansehen: ${v.link}` : "") +
        `\n`,
    },
  },

  "quote-sent": {
    en: {
      subject: (v) => `Quote ${v.number} from ${v.business}`.trim(),
      htmlBody: (v) =>
        `<p>Hello,</p><p>${v.business} has sent you quote <strong>${v.number}</strong> totalling <strong>${v.amount}</strong>.</p>` +
        (v.link ? `<p><a href="${v.link}">View quote</a></p>` : ""),
      textBody: (v) =>
        `Hello,\n\n${v.business} has sent you quote ${v.number} totalling ${v.amount}.` +
        (v.link ? `\n\nView it here: ${v.link}` : "") +
        `\n`,
    },
    es: {
      subject: (v) => `Presupuesto ${v.number} de ${v.business}`.trim(),
      htmlBody: (v) =>
        `<p>Hola,</p><p>${v.business} le ha enviado el presupuesto <strong>${v.number}</strong> por un total de <strong>${v.amount}</strong>.</p>` +
        (v.link ? `<p><a href="${v.link}">Ver presupuesto</a></p>` : ""),
      textBody: (v) =>
        `Hola,\n\n${v.business} le ha enviado el presupuesto ${v.number} por un total de ${v.amount}.` +
        (v.link ? `\n\nVéalo aquí: ${v.link}` : "") +
        `\n`,
    },
    it: {
      subject: (v) => `Preventivo ${v.number} da ${v.business}`.trim(),
      htmlBody: (v) =>
        `<p>Salve,</p><p>${v.business} le ha inviato il preventivo <strong>${v.number}</strong> per un totale di <strong>${v.amount}</strong>.</p>` +
        (v.link ? `<p><a href="${v.link}">Visualizza preventivo</a></p>` : ""),
      textBody: (v) =>
        `Salve,\n\n${v.business} le ha inviato il preventivo ${v.number} per un totale di ${v.amount}.` +
        (v.link ? `\n\nVisualizzalo qui: ${v.link}` : "") +
        `\n`,
    },
    fr: {
      subject: (v) => `Devis ${v.number} de ${v.business}`.trim(),
      htmlBody: (v) =>
        `<p>Bonjour,</p><p>${v.business} vous a envoyé le devis <strong>${v.number}</strong> pour un total de <strong>${v.amount}</strong>.</p>` +
        (v.link ? `<p><a href="${v.link}">Voir le devis</a></p>` : ""),
      textBody: (v) =>
        `Bonjour,\n\n${v.business} vous a envoyé le devis ${v.number} pour un total de ${v.amount}.` +
        (v.link ? `\n\nConsultez-le ici : ${v.link}` : "") +
        `\n`,
    },
    ru: {
      subject: (v) => `Коммерческое предложение ${v.number} от ${v.business}`.trim(),
      htmlBody: (v) =>
        `<p>Здравствуйте,</p><p>${v.business} направил(а) вам коммерческое предложение <strong>${v.number}</strong> на общую сумму <strong>${v.amount}</strong>.</p>` +
        (v.link ? `<p><a href="${v.link}">Посмотреть предложение</a></p>` : ""),
      textBody: (v) =>
        `Здравствуйте,\n\n${v.business} направил(а) вам коммерческое предложение ${v.number} на общую сумму ${v.amount}.` +
        (v.link ? `\n\nПосмотреть можно здесь: ${v.link}` : "") +
        `\n`,
    },
    pt: {
      subject: (v) => `Orçamento ${v.number} de ${v.business}`.trim(),
      htmlBody: (v) =>
        `<p>Olá,</p><p>${v.business} enviou-lhe o orçamento <strong>${v.number}</strong> no valor total de <strong>${v.amount}</strong>.</p>` +
        (v.link ? `<p><a href="${v.link}">Ver orçamento</a></p>` : ""),
      textBody: (v) =>
        `Olá,\n\n${v.business} enviou-lhe o orçamento ${v.number} no valor total de ${v.amount}.` +
        (v.link ? `\n\nVeja-o aqui: ${v.link}` : "") +
        `\n`,
    },
    de: {
      subject: (v) => `Angebot ${v.number} von ${v.business}`.trim(),
      htmlBody: (v) =>
        `<p>Guten Tag,</p><p>${v.business} hat Ihnen das Angebot <strong>${v.number}</strong> über insgesamt <strong>${v.amount}</strong> gesendet.</p>` +
        (v.link ? `<p><a href="${v.link}">Angebot ansehen</a></p>` : ""),
      textBody: (v) =>
        `Guten Tag,\n\n${v.business} hat Ihnen das Angebot ${v.number} über insgesamt ${v.amount} gesendet.` +
        (v.link ? `\n\nHier ansehen: ${v.link}` : "") +
        `\n`,
    },
  },

  "password-reset": {
    en: {
      subject: () => "Reset your password",
      htmlBody: (v) =>
        `<p>We received a request to reset your password.</p>` +
        (v.link ? `<p><a href="${v.link}">Reset your password</a></p>` : "") +
        (v.expiry ? `<p>This link expires in ${v.expiry}.</p>` : "") +
        `<p>If you did not request this, you can ignore this email.</p>`,
      textBody: (v) =>
        `We received a request to reset your password.` +
        (v.link ? `\n\nReset it here: ${v.link}` : "") +
        (v.expiry ? `\n\nThis link expires in ${v.expiry}.` : "") +
        `\n\nIf you did not request this, you can ignore this email.\n`,
    },
    es: {
      subject: () => "Restablezca su contraseña",
      htmlBody: (v) =>
        `<p>Hemos recibido una solicitud para restablecer su contraseña.</p>` +
        (v.link ? `<p><a href="${v.link}">Restablecer su contraseña</a></p>` : "") +
        (v.expiry ? `<p>Este enlace caduca en ${v.expiry}.</p>` : "") +
        `<p>Si no solicitó esto, puede ignorar este mensaje.</p>`,
      textBody: (v) =>
        `Hemos recibido una solicitud para restablecer su contraseña.` +
        (v.link ? `\n\nRestablézcala aquí: ${v.link}` : "") +
        (v.expiry ? `\n\nEste enlace caduca en ${v.expiry}.` : "") +
        `\n\nSi no solicitó esto, puede ignorar este mensaje.\n`,
    },
    it: {
      subject: () => "Reimposti la password",
      htmlBody: (v) =>
        `<p>Abbiamo ricevuto una richiesta di reimpostazione della password.</p>` +
        (v.link ? `<p><a href="${v.link}">Reimposti la password</a></p>` : "") +
        (v.expiry ? `<p>Questo link scade tra ${v.expiry}.</p>` : "") +
        `<p>Se non ha effettuato questa richiesta, può ignorare questa email.</p>`,
      textBody: (v) =>
        `Abbiamo ricevuto una richiesta di reimpostazione della password.` +
        (v.link ? `\n\nLa reimposti qui: ${v.link}` : "") +
        (v.expiry ? `\n\nQuesto link scade tra ${v.expiry}.` : "") +
        `\n\nSe non ha effettuato questa richiesta, può ignorare questa email.\n`,
    },
    fr: {
      subject: () => "Réinitialisez votre mot de passe",
      htmlBody: (v) =>
        `<p>Nous avons reçu une demande de réinitialisation de votre mot de passe.</p>` +
        (v.link ? `<p><a href="${v.link}">Réinitialiser votre mot de passe</a></p>` : "") +
        (v.expiry ? `<p>Ce lien expire dans ${v.expiry}.</p>` : "") +
        `<p>Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail.</p>`,
      textBody: (v) =>
        `Nous avons reçu une demande de réinitialisation de votre mot de passe.` +
        (v.link ? `\n\nRéinitialisez-le ici : ${v.link}` : "") +
        (v.expiry ? `\n\nCe lien expire dans ${v.expiry}.` : "") +
        `\n\nSi vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail.\n`,
    },
    ru: {
      subject: () => "Сброс пароля",
      htmlBody: (v) =>
        `<p>Мы получили запрос на сброс вашего пароля.</p>` +
        (v.link ? `<p><a href="${v.link}">Сбросить пароль</a></p>` : "") +
        (v.expiry ? `<p>Срок действия ссылки истекает через ${v.expiry}.</p>` : "") +
        `<p>Если вы не отправляли этот запрос, просто проигнорируйте это письмо.</p>`,
      textBody: (v) =>
        `Мы получили запрос на сброс вашего пароля.` +
        (v.link ? `\n\nСбросить можно здесь: ${v.link}` : "") +
        (v.expiry ? `\n\nСрок действия ссылки истекает через ${v.expiry}.` : "") +
        `\n\nЕсли вы не отправляли этот запрос, просто проигнорируйте это письмо.\n`,
    },
    pt: {
      subject: () => "Redefina a sua palavra-passe",
      htmlBody: (v) =>
        `<p>Recebemos um pedido para redefinir a sua palavra-passe.</p>` +
        (v.link ? `<p><a href="${v.link}">Redefinir a sua palavra-passe</a></p>` : "") +
        (v.expiry ? `<p>Esta ligação expira em ${v.expiry}.</p>` : "") +
        `<p>Se não solicitou isto, pode ignorar este e-mail.</p>`,
      textBody: (v) =>
        `Recebemos um pedido para redefinir a sua palavra-passe.` +
        (v.link ? `\n\nRedefina-a aqui: ${v.link}` : "") +
        (v.expiry ? `\n\nEsta ligação expira em ${v.expiry}.` : "") +
        `\n\nSe não solicitou isto, pode ignorar este e-mail.\n`,
    },
    de: {
      subject: () => "Setzen Sie Ihr Passwort zurück",
      htmlBody: (v) =>
        `<p>Wir haben eine Anfrage zum Zurücksetzen Ihres Passworts erhalten.</p>` +
        (v.link ? `<p><a href="${v.link}">Passwort zurücksetzen</a></p>` : "") +
        (v.expiry ? `<p>Dieser Link läuft in ${v.expiry} ab.</p>` : "") +
        `<p>Falls Sie dies nicht angefordert haben, können Sie diese E-Mail ignorieren.</p>`,
      textBody: (v) =>
        `Wir haben eine Anfrage zum Zurücksetzen Ihres Passworts erhalten.` +
        (v.link ? `\n\nHier zurücksetzen: ${v.link}` : "") +
        (v.expiry ? `\n\nDieser Link läuft in ${v.expiry} ab.` : "") +
        `\n\nFalls Sie dies nicht angefordert haben, können Sie diese E-Mail ignorieren.\n`,
    },
  },

  "email-verification": {
    en: {
      subject: () => "Verify your email address",
      htmlBody: (v) =>
        `<p>Please confirm your email address.</p>` +
        (v.link ? `<p><a href="${v.link}">Verify email</a></p>` : "") +
        (v.code ? `<p>Your verification code is <strong>${v.code}</strong>.</p>` : ""),
      textBody: (v) =>
        `Please confirm your email address.` +
        (v.link ? `\n\nVerify it here: ${v.link}` : "") +
        (v.code ? `\n\nYour verification code is ${v.code}.` : "") +
        `\n`,
    },
    es: {
      subject: () => "Verifique su dirección de correo electrónico",
      htmlBody: (v) =>
        `<p>Confirme su dirección de correo electrónico.</p>` +
        (v.link ? `<p><a href="${v.link}">Verificar correo</a></p>` : "") +
        (v.code ? `<p>Su código de verificación es <strong>${v.code}</strong>.</p>` : ""),
      textBody: (v) =>
        `Confirme su dirección de correo electrónico.` +
        (v.link ? `\n\nVerifíquela aquí: ${v.link}` : "") +
        (v.code ? `\n\nSu código de verificación es ${v.code}.` : "") +
        `\n`,
    },
    it: {
      subject: () => "Verifichi il Suo indirizzo email",
      htmlBody: (v) =>
        `<p>Confermi il Suo indirizzo email.</p>` +
        (v.link ? `<p><a href="${v.link}">Verifica email</a></p>` : "") +
        (v.code ? `<p>Il Suo codice di verifica è <strong>${v.code}</strong>.</p>` : ""),
      textBody: (v) =>
        `Confermi il Suo indirizzo email.` +
        (v.link ? `\n\nLo verifichi qui: ${v.link}` : "") +
        (v.code ? `\n\nIl Suo codice di verifica è ${v.code}.` : "") +
        `\n`,
    },
    fr: {
      subject: () => "Vérifiez votre adresse e-mail",
      htmlBody: (v) =>
        `<p>Veuillez confirmer votre adresse e-mail.</p>` +
        (v.link ? `<p><a href="${v.link}">Vérifier l'e-mail</a></p>` : "") +
        (v.code ? `<p>Votre code de vérification est <strong>${v.code}</strong>.</p>` : ""),
      textBody: (v) =>
        `Veuillez confirmer votre adresse e-mail.` +
        (v.link ? `\n\nVérifiez-la ici : ${v.link}` : "") +
        (v.code ? `\n\nVotre code de vérification est ${v.code}.` : "") +
        `\n`,
    },
    ru: {
      subject: () => "Подтвердите адрес электронной почты",
      htmlBody: (v) =>
        `<p>Пожалуйста, подтвердите свой адрес электронной почты.</p>` +
        (v.link ? `<p><a href="${v.link}">Подтвердить адрес</a></p>` : "") +
        (v.code ? `<p>Ваш код подтверждения: <strong>${v.code}</strong>.</p>` : ""),
      textBody: (v) =>
        `Пожалуйста, подтвердите свой адрес электронной почты.` +
        (v.link ? `\n\nПодтвердить можно здесь: ${v.link}` : "") +
        (v.code ? `\n\nВаш код подтверждения: ${v.code}.` : "") +
        `\n`,
    },
    pt: {
      subject: () => "Verifique o seu endereço de e-mail",
      htmlBody: (v) =>
        `<p>Confirme o seu endereço de e-mail.</p>` +
        (v.link ? `<p><a href="${v.link}">Verificar e-mail</a></p>` : "") +
        (v.code ? `<p>O seu código de verificação é <strong>${v.code}</strong>.</p>` : ""),
      textBody: (v) =>
        `Confirme o seu endereço de e-mail.` +
        (v.link ? `\n\nVerifique-o aqui: ${v.link}` : "") +
        (v.code ? `\n\nO seu código de verificação é ${v.code}.` : "") +
        `\n`,
    },
    de: {
      subject: () => "Bestätigen Sie Ihre E-Mail-Adresse",
      htmlBody: (v) =>
        `<p>Bitte bestätigen Sie Ihre E-Mail-Adresse.</p>` +
        (v.link ? `<p><a href="${v.link}">E-Mail bestätigen</a></p>` : "") +
        (v.code ? `<p>Ihr Bestätigungscode lautet <strong>${v.code}</strong>.</p>` : ""),
      textBody: (v) =>
        `Bitte bestätigen Sie Ihre E-Mail-Adresse.` +
        (v.link ? `\n\nHier bestätigen: ${v.link}` : "") +
        (v.code ? `\n\nIhr Bestätigungscode lautet ${v.code}.` : "") +
        `\n`,
    },
  },

  // Generic notification: the subject/body/actionLabel are CALLER-SUPPLIED content
  // (already localized by whoever raised the notification), so only the structural
  // assembly is here — there is no fixed prose to translate. All locales share the
  // same assembly; they exist so the catalog stays total over SupportedEmailLocale.
  "generic-notification": buildGenericLocales(),
};

// Kept as a function declaration (hoisted): it's called at module-eval time in the
// template map above its definition, which a `const` arrow can't satisfy.
function buildGenericLocales(): Record<SupportedEmailLocale, TemplateStrings<GenericVars>> {
  const strings: TemplateStrings<GenericVars> = {
    subject: (v) => v.body, // unused: compose supplies the subject directly for generic
    htmlBody: (v) => `<p>${v.body}</p>` + (v.link ? `<p><a href="${v.link}">${v.actionLabel}</a></p>` : ""),
    textBody: (v) => `${v.body}` + (v.link ? `\n\n${v.actionLabel}: ${v.link}` : "") + `\n`,
  };
  const out = {} as Record<SupportedEmailLocale, TemplateStrings<GenericVars>>;
  for (const locale of SUPPORTED_EMAIL_LOCALES) out[locale] = strings;
  return out;
}
