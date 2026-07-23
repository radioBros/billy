/** Contracts module barrel. */
export { createContractsRouter } from "@/modules/contracts/routes.js";
export { CONTRACTS_COLLECTION, ContractRepository } from "@/modules/contracts/repository.js";
export { ContractService, CONTRACT_TRANSITIONS } from "@/modules/contracts/service.js";
export type { ContractServiceDeps } from "@/modules/contracts/service.js";
export {
  ContractCreateSchema,
  ContractUpdateSchema,
  ContractRenewSchema,
  CONTRACT_LIST_WHITELIST,
} from "@/modules/contracts/schema.js";
export type { Contract, ContractStatus, ContractType } from "@/modules/contracts/types.js";
