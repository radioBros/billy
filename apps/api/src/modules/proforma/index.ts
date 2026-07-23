/** Proforma module barrel. Wired into the app router by the integrator. */
export { createProformaRouter, stripProformaFinancial } from "@/modules/proforma/routes.js";
export { PROFORMAS_COLLECTION, ProformaRepository } from "@/modules/proforma/repository.js";
export { ProformaService } from "@/modules/proforma/service.js";
export type {
  ProformaServiceDeps,
  LoadClient,
  NextProformaNumber,
  ClientRecord,
  MintInvoiceFromProforma,
  LoadInvoice,
  ProformaConvertData,
  MintedInvoice,
} from "@/modules/proforma/service.js";
export {
  ProformaCreateSchema,
  ProformaUpdateSchema,
  ClientSnapshotSchema,
  PROFORMA_LIST_WHITELIST,
  type ProformaCreateInput,
  type ProformaUpdateInput,
} from "@/modules/proforma/schema.js";
export type { Proforma, ProformaStatus, ClientSnapshot } from "@/modules/proforma/types.js";
