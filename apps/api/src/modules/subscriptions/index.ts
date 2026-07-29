/**
 * Subscriptions module barrel. Public surface the
 * app composition root wires: the router factory and the collection name.
 */
export { createSubscriptionsRouter } from "@/modules/subscriptions/routes.js";
export { SUBSCRIPTIONS_COLLECTION } from "@/modules/subscriptions/repository.js";
