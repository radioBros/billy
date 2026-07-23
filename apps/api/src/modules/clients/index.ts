/** Clients module barrel. Wired into the app router. */
export { createClientsRouter } from "@/modules/clients/routes.js";
export { CLIENTS_COLLECTION, ClientRepository } from "@/modules/clients/repository.js";
export { ClientService } from "@/modules/clients/service.js";
export {
  ClientCreateSchema,
  ClientUpdateSchema,
  CLIENT_LIST_WHITELIST,
  type ClientCreateInput,
  type ClientUpdateInput,
} from "@/modules/clients/schema.js";
export type { Client, ClientType } from "@/modules/clients/types.js";
