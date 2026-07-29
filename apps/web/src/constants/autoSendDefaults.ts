/**
 * Default auto-send email templates (subject + rich-text body) prefilled when a
 * recurring profile's auto-send is configured for the first time. They use the
 * `{{...}}` placeholder grammar (@billy/shared/template) so every generated
 * occurrence resolves its OWN number / total / dates / client at send time.
 *
 * Kept in TS (not the i18n JSON catalogs) on purpose: vue-i18n treats `{ }` as
 * interpolation syntax, which fights literal `{{token}}` text.
 */
import type { PlaceholderDocType } from "@billy/shared/template";

interface AutoSendDefault {
  subject: string;
  body: string;
}

type DocKind = "invoice" | "proforma";

const T: Record<string, Record<DocKind, AutoSendDefault>> = {
  en: {
    invoice: {
      subject: "Invoice {{document.number}} — {{company.name}}",
      body: "<p>Dear {{client.name}},</p><p>Please find attached invoice {{document.number}} for {{total}}, due on {{dueDate}}.</p><p>Best regards,<br>{{company.name}}</p>",
    },
    proforma: {
      subject: "Proforma {{document.number}} — {{company.name}}",
      body: "<p>Dear {{client.name}},</p><p>Please find attached proforma {{document.number}} for {{total}}, valid until {{expiryDate}}.</p><p>Best regards,<br>{{company.name}}</p>",
    },
  },
  it: {
    invoice: {
      subject: "Fattura {{document.number}} — {{company.name}}",
      body: "<p>Gentile {{client.name}},</p><p>in allegato la fattura {{document.number}} di {{total}}, con scadenza {{dueDate}}.</p><p>Cordiali saluti,<br>{{company.name}}</p>",
    },
    proforma: {
      subject: "Proforma {{document.number}} — {{company.name}}",
      body: "<p>Gentile {{client.name}},</p><p>in allegato la proforma {{document.number}} di {{total}}, valida fino al {{expiryDate}}.</p><p>Cordiali saluti,<br>{{company.name}}</p>",
    },
  },
  de: {
    invoice: {
      subject: "Rechnung {{document.number}} — {{company.name}}",
      body: "<p>Guten Tag {{client.name}},</p><p>anbei erhalten Sie die Rechnung {{document.number}} über {{total}}, fällig am {{dueDate}}.</p><p>Mit freundlichen Grüßen<br>{{company.name}}</p>",
    },
    proforma: {
      subject: "Proforma {{document.number}} — {{company.name}}",
      body: "<p>Guten Tag {{client.name}},</p><p>anbei erhalten Sie die Proforma {{document.number}} über {{total}}, gültig bis {{expiryDate}}.</p><p>Mit freundlichen Grüßen<br>{{company.name}}</p>",
    },
  },
  es: {
    invoice: {
      subject: "Factura {{document.number}} — {{company.name}}",
      body: "<p>Estimado/a {{client.name}}:</p><p>Adjuntamos la factura {{document.number}} por {{total}}, con vencimiento el {{dueDate}}.</p><p>Un saludo,<br>{{company.name}}</p>",
    },
    proforma: {
      subject: "Proforma {{document.number}} — {{company.name}}",
      body: "<p>Estimado/a {{client.name}}:</p><p>Adjuntamos la proforma {{document.number}} por {{total}}, válida hasta el {{expiryDate}}.</p><p>Un saludo,<br>{{company.name}}</p>",
    },
  },
  fr: {
    invoice: {
      subject: "Facture {{document.number}} — {{company.name}}",
      body: "<p>Bonjour {{client.name}},</p><p>Veuillez trouver ci-joint la facture {{document.number}} d'un montant de {{total}}, à régler avant le {{dueDate}}.</p><p>Cordialement,<br>{{company.name}}</p>",
    },
    proforma: {
      subject: "Proforma {{document.number}} — {{company.name}}",
      body: "<p>Bonjour {{client.name}},</p><p>Veuillez trouver ci-joint la proforma {{document.number}} d'un montant de {{total}}, valable jusqu'au {{expiryDate}}.</p><p>Cordialement,<br>{{company.name}}</p>",
    },
  },
  pt: {
    invoice: {
      subject: "Fatura {{document.number}} — {{company.name}}",
      body: "<p>Caro(a) {{client.name}},</p><p>Segue em anexo a fatura {{document.number}} no valor de {{total}}, com vencimento a {{dueDate}}.</p><p>Com os melhores cumprimentos,<br>{{company.name}}</p>",
    },
    proforma: {
      subject: "Proforma {{document.number}} — {{company.name}}",
      body: "<p>Caro(a) {{client.name}},</p><p>Segue em anexo a proforma {{document.number}} no valor de {{total}}, válida até {{expiryDate}}.</p><p>Com os melhores cumprimentos,<br>{{company.name}}</p>",
    },
  },
  ru: {
    invoice: {
      subject: "Счёт {{document.number}} — {{company.name}}",
      body: "<p>Уважаемый(ая) {{client.name}},</p><p>во вложении счёт {{document.number}} на сумму {{total}}, срок оплаты — {{dueDate}}.</p><p>С уважением,<br>{{company.name}}</p>",
    },
    proforma: {
      subject: "Проформа {{document.number}} — {{company.name}}",
      body: "<p>Уважаемый(ая) {{client.name}},</p><p>во вложении проформа {{document.number}} на сумму {{total}}, действительна до {{expiryDate}}.</p><p>С уважением,<br>{{company.name}}</p>",
    },
  },
};

/** Default subject/body for a doc type in the given UI locale (en fallback). */
export const autoSendDefaultTemplate = (
  docType: PlaceholderDocType,
  locale: string,
): AutoSendDefault => {
  const kind: DocKind = docType === "proforma" ? "proforma" : "invoice";
  const lang = T[locale] ?? T.en!;
  return lang[kind];
};
