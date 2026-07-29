import type { Collection } from "mongodb";
import { BaseRepository } from "@/platform/repository.js";
import type { Project } from "@/modules/projects/types.js";

/** Mongo collection name for projects. */
export const PROJECTS_COLLECTION = "projects";

/**
 * Data access for the Project entity. Account-scoped (BaseRepository stamps +
 * filters `accountId` fail-closed). No custom queries beyond the base.
 */
export class ProjectRepository extends BaseRepository<Project> {
  constructor(collection: Collection<Project>) {
    super(collection);
  }
}
