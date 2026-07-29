import type { Context, Next } from "koa";
import { errors } from "@billy/shared";
import type { AppState } from "@/app.js";
import { SESSION_COOKIE_NAME } from "@/modules/auth/session.js";
import type { AuthService } from "@/modules/auth/auth-service.js";

type AuthCtx = Context & { state: AppState };

export const sessionMiddleware = (authService: AuthService) => {
  return async (ctx: AuthCtx, next: Next): Promise<void> => {
    const token = ctx.cookies.get(SESSION_COOKIE_NAME);
    const resolved = await authService.resolve(token ?? undefined);
    if (resolved) {
      ctx.state.authContext = resolved.authContext;
      ctx.state.principal = resolved.principal;
    }
    await next();
  };
};

export const requireAuth = (ctx: AuthCtx, next: Next): Promise<void> => {
  if (!ctx.state.authContext) {
    throw errors.unauthenticated();
  }
  return next();
};
