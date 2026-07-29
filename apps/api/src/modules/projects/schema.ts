import { z } from "zod";
import { NonEmptyString, ObjectIdString } from "@billy/validation";

/**
 * Project Zod schemas. Shape-only validation; account scope is enforced by the
 * repository, not the schema.
 */
export const ProjectCreateSchema = z.object({
  name: NonEmptyString,
  clientId: ObjectIdString.nullable().optional(),
  description: z.string().trim().nullable().optional(),
  color: z.string().trim().nullable().optional(),
});

export const ProjectUpdateSchema = z
  .object({
    name: NonEmptyString,
    clientId: ObjectIdString.nullable(),
    status: z.enum(["active", "archived"]),
    description: z.string().trim().nullable(),
    color: z.string().trim().nullable(),
    version: z.number().int(),
  })
  .partial();

export type ProjectCreateInput = z.infer<typeof ProjectCreateSchema>;
export type ProjectUpdateInput = z.infer<typeof ProjectUpdateSchema>;
