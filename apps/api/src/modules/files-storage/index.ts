/** Files-storage module barrel. Wired into the app router
 *  once `registry.ts` threads the extra `minio` dependency (see routes.ts note). */
export { createFilesStorageRouter } from "@/modules/files-storage/routes.js";
export { FILES_COLLECTION, FileObjectRepository } from "@/modules/files-storage/repository.js";
export { FileService, FILES_BUCKET, type FileServiceDeps, type RequestUploadResult } from "@/modules/files-storage/service.js";
export {
  RequestUploadSchema,
  ConfirmUploadSchema,
  FileIdSchema,
  ALLOWED_MIME_TYPES,
  DEFAULT_MAX_UPLOAD_BYTES,
  FILE_LIST_WHITELIST,
  type RequestUploadInput,
  type ConfirmUploadInput,
} from "@/modules/files-storage/schema.js";
export type {
  FileObject,
  FileOwner,
  ScanStatus,
  FileAction,
  FileAuthorizer,
  FileScanner,
} from "@/modules/files-storage/types.js";
