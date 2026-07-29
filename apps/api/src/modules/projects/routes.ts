import Router from "@koa/router";
import type { Db } from "mongodb";
import type { Logger } from "@billy/shared";
import { validate } from "@/platform/validate.js";
import { respondOk, respondCreated, respondList } from "@/platform/serializer.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import type { AppState } from "@/app.js";
import { ProjectRepository, PROJECTS_COLLECTION } from "@/modules/projects/repository.js";
import { ProjectService } from "@/modules/projects/service.js";
import type { Project } from "@/modules/projects/types.js";
import { ProjectCreateSchema, ProjectUpdateSchema } from "@/modules/projects/schema.js";

/**
 * `/api/v1/projects/*` — account-scoped project CRUD. Thin controllers; the
 * repository enforces account isolation. Every route requires auth.
 */
export const createProjectsRouter = (deps: {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
}): Router<AppState> => {
  const repo = new ProjectRepository(deps.db.collection<Project>(PROJECTS_COLLECTION));
  const service = new ProjectService({ repo, emitter: deps.emitter, logger: deps.logger });

  const r = new Router<AppState>({ prefix: "/api/v1/projects" });

  r.get("/", requireAuth, async (ctx) => {
    const auth = ctx.state.authContext!;
    const { items, meta } = await service.list(auth, ctx.query as Record<string, string | string[] | undefined>);
    respondList(ctx, items as unknown as Record<string, unknown>[], meta);
  });

  r.get("/:id", requireAuth, async (ctx) => {
    const auth = ctx.state.authContext!;
    const doc = await service.get(auth, ctx.params.id as string);
    respondOk(ctx, doc as unknown as Record<string, unknown>);
  });

  r.post("/", requireAuth, async (ctx) => {
    const auth = ctx.state.authContext!;
    const input = validate(ProjectCreateSchema, ctx.request.body);
    const created = await service.create(auth, input);
    respondCreated(ctx, created as unknown as Record<string, unknown>);
  });

  r.patch("/:id", requireAuth, async (ctx) => {
    const auth = ctx.state.authContext!;
    const input = validate(ProjectUpdateSchema, ctx.request.body);
    const version = (input.version as number | undefined) ?? 0;
    const updated = await service.update(auth, ctx.params.id as string, version, input);
    respondOk(ctx, updated as unknown as Record<string, unknown>);
  });

  r.delete("/:id", requireAuth, async (ctx) => {
    const auth = ctx.state.authContext!;
    await service.softDelete(auth, ctx.params.id as string);
    respondOk(ctx, { ok: true });
  });

  return r;
};
