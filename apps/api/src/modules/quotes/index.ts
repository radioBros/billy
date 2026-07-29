/** Quotes module barrel. */
export { createQuotesRouter } from "@/modules/quotes/routes.js";
export { QUOTES_COLLECTION, QuoteRepository } from "@/modules/quotes/repository.js";
export { QuoteService, type QuoteServiceDeps } from "@/modules/quotes/service.js";
export {
  QuoteCreateSchema,
  QuoteUpdateSchema,
  QUOTE_LIST_WHITELIST,
  type QuoteCreateInput,
  type QuoteUpdateInput,
} from "@/modules/quotes/schema.js";
export type {
  Quote,
  QuoteStatus,
  ClientSnapshot,
  ConvertToInvoicePayload,
  ConvertToInvoiceLineInput,
} from "@/modules/quotes/types.js";
