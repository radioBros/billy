/** Invoices module barrel. Wired into the app router by the integrator. */
export { createInvoicesRouter, stripInvoiceFinancial } from "@/modules/invoices/routes.js";
export { INVOICES_COLLECTION, InvoiceRepository } from "@/modules/invoices/repository.js";
export { InvoiceService } from "@/modules/invoices/service.js";
export type {
  InvoiceServiceDeps,
  LoadClient,
  NextInvoiceNumber,
  ClientRecord,
  LoadBankAccounts,
  BankAccountRecord,
} from "@/modules/invoices/service.js";
export {
  InvoiceCreateSchema,
  InvoiceUpdateSchema,
  AddPaymentSchema,
  CreateFromQuoteSchema,
  ClientSnapshotSchema,
  INVOICE_LIST_WHITELIST,
  type InvoiceCreateInput,
  type InvoiceUpdateInput,
  type AddPaymentInput,
  type CreateFromQuoteInput,
} from "@/modules/invoices/schema.js";
export type {
  Invoice,
  InvoiceStatus,
  Payment,
  PaymentMethod,
  ClientSnapshot,
  BankSnapshot,
} from "@/modules/invoices/types.js";
