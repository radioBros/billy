import type { BaseDoc } from "@billy/types";
import type { AddressInput } from "@billy/validation";

/**
 * Client entity (BaseDoc mixin). A single collection with a `type` discriminator
 * — company vs individual — so every downstream `clientId` reference stays
 * uniform. Conditional required fields (company → legalName+displayName,
 * individual → firstName+lastName) are enforced in `schema.ts`.
 *
 * `billingAddress`/`shippingAddress` reuse the frozen `@billy/validation` Address
 * shape. NOTE: the source spec names address subfields differently
 * (street/streetNumber/…); the platform `Address` (line1/city/postalCode/country)
 * is the frozen contract to reuse and is authoritative here.
 *
 * There is no Client status enum — lifecycle is expressed purely via
 * `archivedAt`/`deletedAt` on BaseDoc (no invented status value).
 *
 * All cross-entity references are by string id only (never embedded).
 */
export type ClientType = "company" | "individual";

export interface Client extends BaseDoc {
  type: ClientType;

  // Display / naming (conditional per type — see schema.ts refine)
  displayName: string;
  legalName?: string | null;
  firstName?: string | null;
  lastName?: string | null;

  // Contact
  email?: string | null;
  phone?: string | null;
  website?: string | null;

  // Fiscal identifiers
  vatNumber?: string | null;
  taxCode?: string | null;
  recipientCode?: string | null;
  pecEmail?: string | null;

  // Addresses (embedded sub-documents, reusing @billy/validation Address)
  billingAddress?: AddressInput | null;
  shippingAddress?: AddressInput | null;

  // Locale / commercial defaults
  country?: string | null;
  preferredCurrency?: string | null;
  preferredLanguage?: string | null;
  /** "First Last" contact-person (referral / attention-of). */
  referral?: string | null;
  paymentTermsDays?: number | null;
  defaultTaxRate?: number | null;

  // Freeform
  notes?: string | null;
  tags: string[];
}
