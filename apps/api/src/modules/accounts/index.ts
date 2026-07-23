/** Accounts module barrel. Public surface for app wiring. */
export { createAccountsRouter } from "@/modules/accounts/routes.js";
export { ACCOUNTS_COLLECTION } from "@/modules/accounts/repository.js";
export { AccountService, ACCOUNT_SCOPED_COLLECTIONS } from "@/modules/accounts/service.js";
export type { Account } from "@/modules/accounts/types.js";
