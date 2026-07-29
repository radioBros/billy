import type Koa from "koa";
import type { Db } from "mongodb";
import type { Logger } from "@billy/shared";
import type { DomainEventEmitter } from "@/platform/service.js";
import type { AppState } from "@/app.js";
import type { MinioConn } from "@/infrastructure/minio.js";
import { createClientsRouter } from "@/modules/clients/index.js";
import { createExpensesRouter } from "@/modules/expenses/index.js";
import { createContractsRouter } from "@/modules/contracts/index.js";
import { createTimeTrackingRouter } from "@/modules/time-tracking/index.js";
import { createSubscriptionsRouter } from "@/modules/subscriptions/index.js";
import { createSettingsRouter } from "@/modules/settings/index.js";
import { createDashboardRouter } from "@/modules/dashboard/index.js";
import { createQuotesRouter } from "@/modules/quotes/index.js";
import { createInvoicesRouter } from "@/modules/invoices/index.js";
import { createNotificationsRouter } from "@/modules/notifications/index.js";
import { createPushRouter } from "@/modules/push/index.js";
import { createImportExportRouter } from "@/modules/import-export/index.js";
import { createRecurringBillingRouter } from "@/modules/recurring-billing/index.js";
import { createFilesStorageRouter } from "@/modules/files-storage/index.js";
import { createCreditNotesRouter } from "@/modules/credit-notes/index.js";
import { createProformaRouter } from "@/modules/proforma/index.js";
import { mountPdfGeneration } from "@/modules/pdf-generation/routes.js";
import { createAccountsRouter } from "@/modules/accounts/index.js";
import { createProjectsRouter } from "@/modules/projects/index.js";
import type { UserStore } from "@/modules/auth/users.js";
import type { QueueRegistry } from "@/platform/queue.js";

/**
 * Domain-module route registry (APP-4). The composition root mounts every module
 * router here. Modules are self-contained (each `createXxxRouter` builds its own
 * repository + service from these deps); adding a module = one import + one line.
 * Owned by the integrator so parallel module builds never touch a shared file.
 */
export interface ModuleDeps {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
  /** files-storage needs the MinIO client; other modules ignore it. */
  minio: MinioConn;
  /** pdf-generation needs the job-queue producer to enqueue renders; optional so tests can omit it. */
  queue?: QueueRegistry;
  /** accounts module (sysadmin) needs the user store to create per-account users. */
  users?: UserStore;
}

export const mountDomainModules = (app: Koa<AppState>, deps: ModuleDeps): void => {
  const routers = [
    createClientsRouter(deps),
    createExpensesRouter(deps),
    createContractsRouter(deps),
    createTimeTrackingRouter(deps),
    createSubscriptionsRouter(deps),
    createSettingsRouter(deps),
    createDashboardRouter(deps),
    createQuotesRouter(deps),
    createInvoicesRouter(deps),
    createNotificationsRouter(deps),
    createPushRouter(deps),
    createImportExportRouter(deps),
    createRecurringBillingRouter(deps),
    createFilesStorageRouter(deps),
    createCreditNotesRouter(deps),
    createProformaRouter(deps),
    createProjectsRouter(deps),
    // pdf-generation mounts only when a queue producer is available (it enqueues renders).
    ...(deps.queue ? [mountPdfGeneration({ ...deps, queue: deps.queue })] : []),
    // accounts (sysadmin) mounts only when the user store is available.
    ...(deps.users
      ? [createAccountsRouter({ db: deps.db, users: deps.users, emitter: deps.emitter, logger: deps.logger })]
      : []),
  ];
  for (const router of routers) {
    app.use(router.routes());
    app.use(router.allowedMethods());
  }
};
