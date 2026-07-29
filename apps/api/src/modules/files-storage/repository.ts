import type { Collection } from "mongodb";
import { BaseRepository } from "@/platform/repository.js";
import type { FileObject } from "@/modules/files-storage/types.js";

/** Mongo collection name for file metadata. */
export const FILES_COLLECTION = "files";

/**
 * Data access for {@link FileObject}. Inherits the
 * mandatory-`authContext`, soft-delete, archive, and
 * optimistic-concurrency behaviour from {@link BaseRepository}. No extra operations
 * are needed — the base insert/findById/list/updateVersioned/
 * softDelete cover the pipeline.
 */
export class FileObjectRepository extends BaseRepository<FileObject> {
  constructor(collection: Collection<FileObject>) {
    super(collection);
  }
}
