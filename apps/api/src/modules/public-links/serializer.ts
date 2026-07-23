import type { LineItemComputed } from "@/platform/money.js";
import type {
  PublicInvoiceDTO,
  PublicInvoiceDoc,
  PublicIssuerDTO,
  PublicLineItemDTO,
  PublicQuoteDTO,
  PublicQuoteDoc,
} from "@/modules/public-links/types.js";

const toIssuer = (businessName: string): PublicIssuerDTO => {
  return { businessName };
};

const toPublicLine = (line: LineItemComputed): PublicLineItemDTO => {
  const dto: PublicLineItemDTO = {
    description: line.description,
    quantity: line.quantity,
    unitPriceMinor: line.unitPriceMinor,
    lineSubtotalMinor: line.lineSubtotalMinor,
    lineDiscountMinor: line.lineDiscountMinor,
    lineTaxMinor: line.lineTaxMinor,
    lineTotalMinor: line.lineTotalMinor,
  };
  if (line.discountRate != null) dto.discountRate = line.discountRate;
  if (line.taxRate != null) dto.taxRate = line.taxRate;
  return dto;
};

export const serializePublicQuote = (quote: PublicQuoteDoc, businessName: string): PublicQuoteDTO => {
  const lineItems = Array.isArray(quote.lineItems) ? quote.lineItems.map(toPublicLine) : [];
  return {
    documentType: "quote",
    documentNumber: quote.quoteNumber ?? null,
    status: quote.status,
    currency: quote.currency,
    issueDate: quote.issueDate,
    expiryDate: quote.expiryDate,
    lineItems,
    subtotalMinor: quote.subtotalMinor,
    discountMinor: quote.discountMinor,
    taxMinor: quote.taxMinor,
    grandTotalMinor: quote.grandTotalMinor,
    clientDisplayName: quote.clientSnapshot?.displayName ?? null,
    issuer: toIssuer(businessName),
    acceptedAt: quote.acceptedAt ?? null,
    declinedAt: quote.declinedAt ?? null,
  };
};

export const serializePublicInvoice = (invoice: PublicInvoiceDoc, businessName: string): PublicInvoiceDTO => {
  const lineItems = Array.isArray(invoice.lineItems) ? invoice.lineItems.map(toPublicLine) : [];
  return {
    documentType: "invoice",
    documentNumber: invoice.invoiceNumber ?? null,
    status: invoice.status,
    currency: invoice.currency,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    lineItems,
    subtotalMinor: invoice.subtotalMinor,
    discountMinor: invoice.discountMinor,
    taxMinor: invoice.taxMinor,
    grandTotalMinor: invoice.grandTotalMinor,
    clientDisplayName: invoice.clientSnapshot?.displayName ?? null,
    issuer: toIssuer(businessName),
  };
};
