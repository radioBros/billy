import Router from "@koa/router";
import { z } from "zod";
import type { Db } from "mongodb";
import type { Logger } from "@billy/shared";
import type { AuthContext } from "@billy/types";
import { validate } from "@/platform/validate.js";
import {
  respondOk,
  respondCreated,
  respondList,
  stripFinancial,
  stripFinancialList,
} from "@/platform/serializer.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import type { AppState } from "@/app.js";
import { ExpenseRepository, EXPENSES_COLLECTION } from "@/modules/expenses/repository.js";
import { ExpenseService } from "@/modules/expenses/service.js";
import type { Expense } from "@/modules/expenses/types.js";
import { ExpenseCreateSchema, ExpenseUpdateSchema, ExpenseMarkInvoicedSchema } from "@/modules/expenses/schema.js";

/**
 * `/api/v1/expenses/*` routes. Thin controllers: they
 * marshal ctx ↔ service and serialize the envelope — no domain branching.
 * Every route requires auth. `amountMinor` is a financial field,
 * so it is stripped from every response for callers lacking
 * `canViewFinancialTotals`.
 */

/** Financial fields removed server-side for restricted callers. */
const FINANCIAL_FIELDS = ["amountMinor"] as const;

const present = (auth: AuthContext, doc: Expense): Record<string, unknown> => {
  return stripFinancial(auth, { ...doc } as Record<string, unknown>, FINANCIAL_FIELDS);
};

const presentList = (auth: AuthContext, docs: readonly Expense[]): Record<string, unknown>[] => {
  return stripFinancialList(auth, docs.map((d) => ({ ...d }) as Record<string, unknown>), FINANCIAL_FIELDS);
};

export const createExpensesRouter = (deps: {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
}): Router<AppState> => {
  const repo = new ExpenseRepository(deps.db.collection<Expense>(EXPENSES_COLLECTION));
  const service = new ExpenseService({ repo, emitter: deps.emitter, logger: deps.logger });

  const r = new Router<AppState>({ prefix: "/api/v1/expenses" });

  // List — server-paginated/sorted/searched.
  r.get("/", requireAuth, async (ctx) => {
    const auth = ctx.state.authContext!;
    const { items, meta } = await service.list(auth, ctx.query as Record<string, string | string[] | undefined>);
    respondList(ctx, presentList(auth, items), meta);
  });

  // Read one.
  r.get("/:id", requireAuth, async (ctx) => {
    const auth = ctx.state.authContext!;
    const doc = await service.get(auth, ctx.params.id as string);
    respondOk(ctx, present(auth, doc));
  });

  // Create.
  r.post("/", requireAuth, async (ctx) => {
    const auth = ctx.state.authContext!;
    const input = validate(ExpenseCreateSchema, ctx.request.body);
    const created = await service.create(auth, input);
    respondCreated(ctx, present(auth, created));
  });

  // Update (optimistic concurrency via body `version`).
  r.patch("/:id", requireAuth, async (ctx) => {
    const auth = ctx.state.authContext!;
    const input = validate(ExpenseUpdateSchema, ctx.request.body);
    const updated = await service.update(auth, ctx.params.id as string, input.version, input);
    respondOk(ctx, present(auth, updated));
  });

  // Soft-delete.
  r.delete("/:id", requireAuth, async (ctx) => {
    const auth = ctx.state.authContext!;
    await service.softDelete(auth, ctx.params.id as string);
    respondOk(ctx, { ok: true });
  });

  // Archive.
  r.post("/:id/archive", requireAuth, async (ctx) => {
    const auth = ctx.state.authContext!;
    const { version } = validate(VersionBodySchema, ctx.request.body);
    const archived = await service.archive(auth, ctx.params.id as string, version);
    respondOk(ctx, present(auth, archived));
  });

  // Restore.
  r.post("/:id/restore", requireAuth, async (ctx) => {
    const auth = ctx.state.authContext!;
    const { version } = validate(VersionBodySchema, ctx.request.body);
    const restored = await service.restore(auth, ctx.params.id as string, version);
    respondOk(ctx, present(auth, restored));
  });

  // Add to a draft invoice — duplicate-invoicing prevention.
  r.post("/:id/mark-invoiced", requireAuth, async (ctx) => {
    const auth = ctx.state.authContext!;
    const { invoiceId, version } = validate(ExpenseMarkInvoicedSchema, ctx.request.body);
    const updated = await service.markInvoiced(auth, ctx.params.id as string, version, invoiceId);
    respondOk(ctx, present(auth, updated));
  });

  return r;
};

/** Body schema for the version-only action endpoints (archive/restore). */
const VersionBodySchema = z.object({ version: z.number().int().nonnegative() });
