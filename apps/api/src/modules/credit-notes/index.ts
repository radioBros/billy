/** Credit-notes module barrel. Wired into the app router. */
export { createCreditNotesRouter, stripCreditNoteFinancial } from "@/modules/credit-notes/routes.js";
export { CREDIT_NOTES_COLLECTION, CreditNoteRepository } from "@/modules/credit-notes/repository.js";
export { CreditNoteService } from "@/modules/credit-notes/service.js";
export type {
  CreditNoteServiceDeps,
  LoadClient,
  NextCreditNoteNumber,
  ClientRecord,
} from "@/modules/credit-notes/service.js";
export {
  CreditNoteCreateSchema,
  CreditNoteUpdateSchema,
  ClientSnapshotSchema,
  CREDIT_NOTE_LIST_WHITELIST,
  type CreditNoteCreateInput,
  type CreditNoteUpdateInput,
} from "@/modules/credit-notes/schema.js";
export type { CreditNote, CreditNoteStatus, ClientSnapshot } from "@/modules/credit-notes/types.js";
