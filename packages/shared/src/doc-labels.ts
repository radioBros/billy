// -----------------------------------------------------------------------------
// DOCUMENT LABELS — the structural, system-owned strings printed on PDFs and
// emails (headings, table columns, totals rows, the "no." / "of" number line).
// These are localized to the RECIPIENT's language (see resolveDocumentLocale in
// locales.ts), independent of the app's UI language and of the company's own
// free-text (notes/header/footer, which are handled separately, per-language).
//
// Adding a language: add its entry to LOCALES (locales.ts) AND a block here with
// the same keys. `docLabels(locale)` falls back to English for any missing
// locale so a partially-translated language still renders.
// -----------------------------------------------------------------------------

/** Every structural label a rendered document/email needs. */
export interface DocLabels {
  invoice: string;
  quote: string;
  creditNote: string;
  proforma: string;
  contract: string;
  /** "no." — precedes the document number ("Invoice no. 20/2026"). */
  numberWord: string;
  /** "of" — precedes the issue date ("… of 2026-07-15"). */
  dateWord: string;
  sender: string;
  recipient: string;
  /** VAT-number label ("VAT" / "P.IVA" / …). */
  vat: string;
  /** "Subject" — heading above the line items. */
  subject: string;
  issueDate: string;
  dueDate: string;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
  paid: string;
  amountDue: string;
  bankDetails: string;
  notes: string;
  page: string;
}

const EN: DocLabels = {
  invoice: "Invoice",
  quote: "Quote",
  creditNote: "Credit note",
  proforma: "Proforma",
  contract: "Contract",
  numberWord: "no.",
  dateWord: "of",
  sender: "Sender",
  recipient: "Recipient",
  subject: "Subject",
  vat: "VAT",
  issueDate: "Issue date",
  dueDate: "Due date",
  description: "Description",
  quantity: "Qty",
  unitPrice: "Unit price",
  amount: "Amount",
  subtotal: "Subtotal",
  discount: "Discount",
  tax: "Tax",
  total: "Total",
  paid: "Paid",
  amountDue: "Amount Due",
  bankDetails: "Bank details",
  notes: "Notes",
  page: "Page",
};

const IT: DocLabels = {
  invoice: "Fattura",
  quote: "Preventivo",
  creditNote: "Nota di credito",
  proforma: "Proforma",
  contract: "Contratto",
  numberWord: "n.",
  dateWord: "del",
  sender: "Mittente",
  recipient: "Destinatario",
  subject: "Oggetto",
  vat: "P.IVA",
  issueDate: "Data emissione",
  dueDate: "Scadenza",
  description: "Descrizione",
  quantity: "Qtà",
  unitPrice: "Prezzo unitario",
  amount: "Importo",
  subtotal: "Imponibile",
  discount: "Sconto",
  tax: "IVA",
  total: "Totale",
  paid: "Pagato",
  amountDue: "Importo dovuto",
  bankDetails: "Coordinate bancarie",
  notes: "Note",
  page: "Pagina",
};

const ES: DocLabels = {
  invoice: "Factura",
  quote: "Presupuesto",
  creditNote: "Nota de crédito",
  proforma: "Proforma",
  contract: "Contrato",
  numberWord: "n.º",
  dateWord: "de",
  sender: "Remitente",
  recipient: "Destinatario",
  subject: "Asunto",
  vat: "IVA",
  issueDate: "Fecha de emisión",
  dueDate: "Vencimiento",
  description: "Descripción",
  quantity: "Cant.",
  unitPrice: "Precio unitario",
  amount: "Importe",
  subtotal: "Subtotal",
  discount: "Descuento",
  tax: "IVA",
  total: "Total",
  paid: "Pagado",
  amountDue: "Importe pendiente",
  bankDetails: "Datos bancarios",
  notes: "Notas",
  page: "Página",
};

const FR: DocLabels = {
  invoice: "Facture",
  quote: "Devis",
  creditNote: "Avoir",
  proforma: "Proforma",
  contract: "Contrat",
  numberWord: "n°",
  dateWord: "du",
  sender: "Expéditeur",
  recipient: "Destinataire",
  subject: "Objet",
  vat: "TVA",
  issueDate: "Date d'émission",
  dueDate: "Échéance",
  description: "Description",
  quantity: "Qté",
  unitPrice: "Prix unitaire",
  amount: "Montant",
  subtotal: "Sous-total",
  discount: "Remise",
  tax: "TVA",
  total: "Total",
  paid: "Payé",
  amountDue: "Montant dû",
  bankDetails: "Coordonnées bancaires",
  notes: "Notes",
  page: "Page",
};

const DE: DocLabels = {
  invoice: "Rechnung",
  quote: "Angebot",
  creditNote: "Gutschrift",
  proforma: "Proforma",
  contract: "Vertrag",
  numberWord: "Nr.",
  dateWord: "vom",
  sender: "Absender",
  recipient: "Empfänger",
  subject: "Betreff",
  vat: "USt-IdNr.",
  issueDate: "Rechnungsdatum",
  dueDate: "Fällig am",
  description: "Beschreibung",
  quantity: "Menge",
  unitPrice: "Einzelpreis",
  amount: "Betrag",
  subtotal: "Zwischensumme",
  discount: "Rabatt",
  tax: "MwSt.",
  total: "Summe",
  paid: "Bezahlt",
  amountDue: "Offener Betrag",
  bankDetails: "Bankverbindung",
  notes: "Anmerkungen",
  page: "Seite",
};

const PT: DocLabels = {
  invoice: "Fatura",
  quote: "Orçamento",
  creditNote: "Nota de crédito",
  proforma: "Proforma",
  contract: "Contrato",
  numberWord: "n.º",
  dateWord: "de",
  sender: "Remetente",
  recipient: "Destinatário",
  subject: "Assunto",
  vat: "IVA",
  issueDate: "Data de emissão",
  dueDate: "Vencimento",
  description: "Descrição",
  quantity: "Qtd.",
  unitPrice: "Preço unitário",
  amount: "Valor",
  subtotal: "Subtotal",
  discount: "Desconto",
  tax: "IVA",
  total: "Total",
  paid: "Pago",
  amountDue: "Valor em dívida",
  bankDetails: "Dados bancários",
  notes: "Notas",
  page: "Página",
};

const RU: DocLabels = {
  invoice: "Счёт",
  quote: "Коммерческое предложение",
  creditNote: "Кредит-нота",
  proforma: "Проформа",
  contract: "Договор",
  numberWord: "№",
  dateWord: "от",
  sender: "Отправитель",
  recipient: "Получатель",
  subject: "Тема",
  vat: "НДС",
  issueDate: "Дата выставления",
  dueDate: "Срок оплаты",
  description: "Описание",
  quantity: "Кол-во",
  unitPrice: "Цена за ед.",
  amount: "Сумма",
  subtotal: "Промежуточный итог",
  discount: "Скидка",
  tax: "НДС",
  total: "Итого",
  paid: "Оплачено",
  amountDue: "К оплате",
  bankDetails: "Банковские реквизиты",
  notes: "Примечания",
  page: "Страница",
};

const TABLE: Record<string, DocLabels> = { en: EN, it: IT, es: ES, fr: FR, de: DE, pt: PT, ru: RU };

/**
 * The document/email structural labels for `locale`, falling back to English for
 * an unknown or partially-translated locale. `locale` should already be a base
 * code (use normalizeLocale/resolveDocumentLocale from locales.ts first).
 */
export const docLabels = (locale: string): DocLabels => TABLE[locale] ?? EN;
