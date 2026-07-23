import type { AuthContext, BaseDoc, ListMeta } from "@billy/types";
import { errors } from "@billy/shared";
import { BaseService, type ServiceDeps } from "@/platform/service.js";
import type { ProjectCreateInput, ProjectUpdateInput } from "@/modules/projects/schema.js";
import { PROJECT_LIST_WHITELIST, type Project } from "@/modules/projects/types.js";
import type { ProjectRepository } from "@/modules/projects/repository.js";

/**
 * Project business logic. A thin account-scoped CRUD entity; the repository
 * enforces isolation. `project.*` domain events on mutation.
 */
export interface ProjectServiceDeps extends ServiceDeps<Project> {
  repo: ProjectRepository;
}

export interface ProjectListResult {
  items: Project[];
  meta: ListMeta;
}

export class ProjectService extends BaseService<Project> {
  protected override readonly repo: ProjectRepository;

  constructor(deps: ProjectServiceDeps) {
    super(deps);
    this.repo = deps.repo;
  }

  async list(ctx: AuthContext, rawQuery: Record<string, string | string[] | undefined>): Promise<ProjectListResult> {
    const { items, parsed, total } = await this.repo.list(ctx, rawQuery, PROJECT_LIST_WHITELIST);
    const meta: ListMeta = {
      page: parsed.page,
      limit: parsed.limit,
      total,
      pageCount: Math.max(1, Math.ceil(total / parsed.limit)),
      sort: parsed.sortSpec,
      ...(parsed.q ? { q: parsed.q } : {}),
    };
    return { items, meta };
  }

  async get(ctx: AuthContext, id: string): Promise<Project> {
    const doc = await this.repo.findById(ctx, id);
    if (!doc) throw errors.notFound();
    return doc;
  }

  async create(ctx: AuthContext, input: ProjectCreateInput): Promise<Project> {
    const data = {
      name: input.name,
      clientId: input.clientId ?? null,
      status: "active",
      description: input.description ?? null,
      color: input.color ?? null,
    } as Omit<Project, keyof BaseDoc>;
    const created = await this.repo.insert(ctx, data);
    await this.emit({ name: "project.created", actorId: ctx.userId, entityType: "project", entityId: created.id });
    return created;
  }

  async update(ctx: AuthContext, id: string, expectedVersion: number, patch: ProjectUpdateInput): Promise<Project> {
    const { version: _v, ...rest } = patch;
    void _v;
    const updated = await this.repo.updateVersioned(ctx, id, expectedVersion, rest as Partial<Project>);
    await this.emit({ name: "project.updated", actorId: ctx.userId, entityType: "project", entityId: id });
    return updated;
  }

  async softDelete(ctx: AuthContext, id: string): Promise<void> {
    await this.repo.softDelete(ctx, id);
    await this.emit({ name: "project.deleted", actorId: ctx.userId, entityType: "project", entityId: id });
  }
}
