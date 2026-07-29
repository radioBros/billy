import Router from "@koa/router";
import { z } from "zod";
import type { Db } from "mongodb";
import type { Logger } from "@billy/shared";
import { AppError } from "@billy/shared";
import { validate } from "@/platform/validate.js";
import { respondOk, respondCreated, respondList } from "@/platform/serializer.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import type { AppState } from "@/app.js";
import { AccountRepository, ACCOUNTS_COLLECTION } from "@/modules/accounts/repository.js";
import { AccountService } from "@/modules/accounts/service.js";
import type { Account } from "@/modules/accounts/types.js";
import { AccountCreateSchema, AccountUpdateSchema, AccountDeleteSchema } from "@/modules/accounts/schema.js";
import { type UserStore } from "@/modules/auth/users.js";

/**
 * `/api/v1/accounts/*` — SYSADMIN-ONLY account management. Every route requires
 * auth AND the sysadmin role (the service also re-checks). This is the narrow
 * cross-account surface; all other modules stay scoped to the active account.
 */
export const createAccountsRouter = (deps: {
  db: Db;
  users: UserStore;
  emitter: DomainEventEmitter;
  logger: Logger;
}): Router<AppState> => {
  const repo = new AccountRepository(deps.db.collection<Account>(ACCOUNTS_COLLECTION));
  const service = new AccountService({
    repo,
    users: deps.users,
    db: deps.db,
    emitter: deps.emitter,
    logger: deps.logger,
  });

  const r = new Router<AppState>({ prefix: "/api/v1/accounts" });

  r.get("/", requireAuth, async (ctx) => {
    const auth = ctx.state.authContext!;
    if (!auth.isSysadmin) throw new AppError("FORBIDDEN", "Sysadmin only");
    const items = await service.list(auth);
    respondList(ctx, items as unknown as Record<string, unknown>[], {
      page: 1,
      limit: items.length,
      total: items.length,
      pageCount: 1,
      sort: [],
    });
  });

  r.get("/:id", requireAuth, async (ctx) => {
    const auth = ctx.state.authContext!;
    const acc = await service.get(auth, ctx.params.id as string);
    respondOk(ctx, acc as unknown as Record<string, unknown>);
  });

  r.post("/", requireAuth, async (ctx) => {
    const auth = ctx.state.authContext!;
    const input = validate(AccountCreateSchema, ctx.request.body);
    const created = await service.create(auth, input);
    respondCreated(ctx, created as unknown as Record<string, unknown>);
  });

  r.patch("/:id", requireAuth, async (ctx) => {
    const auth = ctx.state.authContext!;
    const body = validate(AccountUpdateSchema.extend({ version: z.number().int() }), ctx.request.body);
    const { version, ...patch } = body;
    const updated = await service.update(auth, ctx.params.id as string, version, patch);
    respondOk(ctx, updated as unknown as Record<string, unknown>);
  });

  // Destructive delete — secure multi-step (name echo + sysadmin password).
  r.post("/:id/delete", requireAuth, async (ctx) => {
    const auth = ctx.state.authContext!;
    const input = validate(AccountDeleteSchema, ctx.request.body);
    await service.destroy(auth, ctx.params.id as string, input);
    respondOk(ctx, { ok: true });
  });

  return r;
};
