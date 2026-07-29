import type { Collection } from "mongodb";
import type { AuthContext } from "@billy/types";
import { GlobalRepository } from "@/platform/repository.js";
import type { Account } from "@/modules/accounts/types.js";

/** Mongo collection name for accounts. */
export const ACCOUNTS_COLLECTION = "accounts";

/**
 * Data access for the Account entity. Accounts are the tenant boundary itself, so
 * they are a GLOBAL collection (not account-scoped) — extends GlobalRepository.
 * Only the sysadmin reaches this (routes enforce it).
 */
export class AccountRepository extends GlobalRepository<Account> {
  constructor(collection: Collection<Account>) {
    super(collection);
  }

  /** Look up by slug (uniqueness check + display). */
  async findBySlug(slug: string): Promise<Account | null> {
    const doc = await this.collection.findOne({ slug, deletedAt: null }, { projection: { _id: 0 } });
    return (doc as Account | null) ?? null;
  }

  /** Fetch by id ignoring the active/soft-delete guards (sysadmin management). */
  async findByIdRaw(id: string): Promise<Account | null> {
    const doc = await this.collection.findOne({ id }, { projection: { _id: 0 } });
    return (doc as Account | null) ?? null;
  }

  /** Non-deleted accounts (sysadmin listing / account switcher), name-sorted. */
  async listAll(ctx: AuthContext): Promise<Account[]> {
    return this.list(ctx, { sort: "name", limit: "500" }, {
      sortable: ["name", "createdAt", "status"],
      filterable: ["status"],
      searchable: ["name", "slug"],
    }).then((r) => r.items);
  }
}
