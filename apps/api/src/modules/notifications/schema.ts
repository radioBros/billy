import { z } from "zod";
import type { ListWhitelist } from "@billy/types";
import { NOTIFICATION_CATEGORIES } from "@/modules/notifications/types.js";

/**
 * Notifications Zod schemas (one schema per entity, shared by API + web).
 * This validates the per-category in-app preference PATCH and the notification
 * list query whitelist. The exhaustive per-EVENT preference matrix (generated
 * from the seed table) is DEFERRED.
 */

/** A single category's channel toggles. Only `inApp` is live currently. */
const CategoryToggleSchema = z
  .object({
    inApp: z.boolean(),
    // `push` / `email` toggles to be added when those channels land.
  })
  .strict();

const CategoryEnum = z.enum(
  NOTIFICATION_CATEGORIES as unknown as [string, ...string[]],
);

/**
 * PATCH /preferences body: a partial map of category → toggles. Every key must
 * be a known category; provided categories are merged over the stored document.
 */
export const PreferencesUpdateSchema = z
  .object({
    categories: z.record(CategoryEnum, CategoryToggleSchema),
  })
  .strict();

export type PreferencesUpdateInput = z.infer<typeof PreferencesUpdateSchema>;

/**
 * List query whitelist (keeps list queries index-backed).
 * Filter by category/severity/read-state. Search across title/body. Default
 * sort (unread-first) is applied in the repository.
 */
export const NOTIFICATION_LIST_WHITELIST: ListWhitelist = {
  sortable: ["createdAt", "readAt", "severity"],
  filterable: ["category", "severity", "type", "entityType", "readAt"],
  searchable: ["title", "body"],
};
