import Router from "@koa/router";
import type { Logger } from "@billy/shared";
import { validate } from "@/platform/validate.js";
import { respondOk, respondCreated } from "@/platform/serializer.js";
import type { AppState } from "@/app.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import type { UserStore } from "@/modules/auth/users.js";
import type { AuthService } from "@/modules/auth/auth-service.js";
import {
  UserAdminService,
  CreateUserSchema,
  UpdateUserSchema,
  ResetPasswordSchema,
} from "@/modules/auth/user-admin.js";

/**
 * Admin user-management routes under /api/v1/users. All require an
 * authenticated session; the `canManageUsers` capability is enforced in the
 * service (server-side, per method) so a missing capability yields CAPABILITY_DENIED.
 */
export const createUsersRouter = (deps: {
  users: UserStore;
  authService: AuthService;
  emitter: DomainEventEmitter;
  logger: Logger;
}): Router<AppState> => {
  const service = new UserAdminService({
    users: deps.users,
    emitter: deps.emitter,
    logger: deps.logger,
    authService: deps.authService,
  });

  const r = new Router<AppState>({ prefix: "/api/v1/users" });
  r.use(requireAuth);

  r.get("/", async (ctx) => {
    respondOk(ctx, await service.list(ctx.state.authContext!));
  });

  r.post("/", async (ctx) => {
    const input = validate(CreateUserSchema, ctx.request.body);
    respondCreated(ctx, await service.create(ctx.state.authContext!, input));
  });

  r.patch("/:id", async (ctx) => {
    const input = validate(UpdateUserSchema, ctx.request.body);
    respondOk(ctx, await service.update(ctx.state.authContext!, ctx.params.id!, input));
  });

  r.post("/:id/reset-password", async (ctx) => {
    const input = validate(ResetPasswordSchema, ctx.request.body);
    respondOk(ctx, await service.resetPassword(ctx.state.authContext!, ctx.params.id!, input));
  });

  r.delete("/:id", async (ctx) => {
    await service.softDelete(ctx.state.authContext!, ctx.params.id!);
    respondOk(ctx, { deleted: true });
  });

  return r;
};
