import { createDecipheriv, createHash } from "node:crypto";
import { AppError, type Logger } from "@billy/shared";
import type { EmailJob } from "@billy/types";
import { Client as MinioClient } from "minio";
import { MongoClient } from "mongodb";
import nodemailer, { type Transporter } from "nodemailer";
import type { ProcessorContext } from "@/processors.js";

/**
 * Email send handler.
 *
 * The API composes + enqueues; THIS runs in the worker and performs the actual
 * SMTP send (send happens ONLY in the worker — isolation). It:
 *   1. resolves SMTP config with precedence **DB settings → env → default**:
 *      reads the `email` settings doc from Mongo, decrypts the
 *      field-encrypted `smtpPasswordEnc`, and falls back to `SMTP_*` env, then
 *      built-in defaults,
 *   2. falls back to `jsonTransport` when no host is resolved (dev / no server)
 *      so it composes the message without a real send and still "succeeds",
 *   3. sends the rendered subject/html/text (carried in `EmailJob.data` by the
 *      API compose step),
 *   4. throws `EMAIL_DELIVERY_FAILED` on failure so BullMQ retries; a final
 *      failure surfaces via the worker's `failed` listener.
 *
 * SECRETS: the SMTP password (env `SMTP_PASSWORD` or DB `smtpPasswordEnc`) is
 * NEVER logged. `DATA_ENCRYPTION_KEY` (env) is the field-decryption key.
 *
 * NOTE (intentional duplication): the field-decryption primitive below MUST
 * stay byte-identical to `apps/api/src/platform/crypto.ts` (v1 format, sha256-
 * derived 32-byte key, 12-byte IV, AES-256-GCM, base64url). The worker cannot
 * import it (tsconfig `rootDir:"src"` scopes the worker to `apps/worker/src`,
 * and a shared package is out of scope), so the decrypt is inlined here. Any
 * change to the crypto format must be mirrored in both files.
 */

/** Resolved SMTP configuration (no secrets logged). */
export interface SmtpConfig {
  host?: string;
  port: number;
  secure: boolean;
  username?: string;
  password?: string;
  fromEmail: string;
  fromName: string;
}

/** The subset of the `email` settings doc the worker reads (see API types). */
export interface EmailSettingsDbData {
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpSecure?: boolean | null;
  smtpUsername?: string | null;
  smtpPasswordEnc?: string | null;
  fromEmail?: string | null;
  fromName?: string | null;
}

const DEFAULT_PORT = 587;
const DEFAULT_FROM_EMAIL = "no-reply@billy.local";
const DEFAULT_FROM_NAME = "Billy";

const parseBool = (v: string | undefined): boolean => {
  return v === "true" || v === "1" || v === "yes";
};

const decryptField = (ciphertext: string, keyMaterial: string): string | undefined => {
  const parts = ciphertext.split(":");
  const [version, ivB64, tagB64, ctB64] = parts;
  if (parts.length !== 4 || version !== "v1" || !ivB64 || !tagB64 || ctB64 === undefined) {
    return undefined;
  }
  try {
    const key = createHash("sha256").update(keyMaterial, "utf8").digest();
    const iv = Buffer.from(ivB64, "base64url");
    const tag = Buffer.from(tagB64, "base64url");
    const ct = Buffer.from(ctB64, "base64url");
    if (iv.length !== 12 || tag.length !== 16) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
};

const readEnvSmtpConfig = (env: NodeJS.ProcessEnv): SmtpConfig => {
  const portRaw = env.SMTP_PORT;
  const port = portRaw && Number.isFinite(Number(portRaw)) ? Number(portRaw) : DEFAULT_PORT;
  return {
    host: env.SMTP_HOST || undefined,
    port,
    secure: parseBool(env.SMTP_SECURE),
    username: env.SMTP_USERNAME || undefined,
    password: env.SMTP_PASSWORD || undefined,
    fromEmail: env.SMTP_FROM_EMAIL || DEFAULT_FROM_EMAIL,
    fromName: env.SMTP_FROM_NAME || DEFAULT_FROM_NAME,
  };
};

export const mergeSmtpConfig = (db: EmailSettingsDbData | null, env: NodeJS.ProcessEnv, decryptedPassword?: string): SmtpConfig => {
  const envCfg = readEnvSmtpConfig(env);
  if (!db || !db.smtpHost) {
    // No DB override → env (which itself falls back to defaults).
    return {
      ...envCfg,
      fromEmail: db?.fromEmail || envCfg.fromEmail,
      fromName: db?.fromName || envCfg.fromName,
    };
  }
  // DB has a host → DB is authoritative for the connection.
  return {
    host: db.smtpHost,
    port: db.smtpPort ?? DEFAULT_PORT,
    secure: db.smtpSecure ?? false,
    username: db.smtpUsername || undefined,
    password: decryptedPassword,
    fromEmail: db.fromEmail || envCfg.fromEmail,
    fromName: db.fromName || envCfg.fromName,
  };
};

export const buildTransport = (cfg: SmtpConfig): { transport: Transporter; usingJson: boolean } => {
  if (!cfg.host) {
    return { transport: nodemailer.createTransport({ jsonTransport: true }), usingJson: true };
  }
  const auth =
    cfg.username && cfg.password ? { user: cfg.username, pass: cfg.password } : undefined;
  return {
    transport: nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      ...(auth ? { auth } : {}),
    }),
    usingJson: false,
  };
};

const readRendered = (data: EmailJob["data"]): { subject: string; html: string; text: string } => {
  const d = data ?? {};
  return {
    subject: typeof d.subject === "string" ? d.subject : "",
    html: typeof d.html === "string" ? d.html : "",
    text: typeof d.text === "string" ? d.text : "",
  };
};

/**
 * Lazy, cached Mongo access for reading the `email` settings doc. The client is
 * created on first use (NEVER at import time — that would fire during tests) and
 * reused. A short server-selection timeout + an "unavailable" cache means that
 * when Mongo is down/unset (e.g. dev, unit tests) the read fails fast and falls
 * through to env → default. The worker only READS settings (never writes).
 */
let cachedClient: MongoClient | null = null;
let mongoUnavailable = false;

const readEmailSettingsFromDb = async (logger: Logger): Promise<EmailSettingsDbData | null> => {
  if (mongoUnavailable) return null;
  const uri = process.env.MONGO_URI;
  if (!uri) return null;
  try {
    if (!cachedClient) {
      cachedClient = new MongoClient(uri, { serverSelectionTimeoutMS: 1000 });
    }
    const db = cachedClient.db(); // honors the db name embedded in MONGO_URI
    const doc = await db
      .collection<{ key: string; data: EmailSettingsDbData }>("settings")
      .findOne({ key: "email" });
    return (doc?.data as EmailSettingsDbData | undefined) ?? null;
  } catch (err) {
    // Fail closed to env → default; cache so repeated jobs don't re-stall.
    mongoUnavailable = true;
    logger.debug({ queue: "email", err }, "email settings DB read unavailable — using env/default");
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Attachment resolution (REFS → bytes): the API enqueues attachment REFERENCES
// (fileId + filename), never bytes. The worker resolves each ref to its
// FileObject (in the `files` collection) → MinIO object → Buffer at send time.
// ─────────────────────────────────────────────────────────────────────────────

const FILES_BUCKET = "billy-files";
const FILES_COLLECTION = "files";

/** The subset of a stored FileObject the attachment fetch needs. */
interface AttachmentFileObject {
  objectKey: string;
  scanStatus?: string;
}

/** Lazy, cached MinIO client (mirrors handlers/pdf.ts getMinio()). */
let minioClient: MinioClient | null = null;

const getMinio = (): MinioClient => {
  if (!minioClient) {
    minioClient = new MinioClient({
      endPoint: process.env.MINIO_ENDPOINT ?? "localhost",
      port: process.env.MINIO_PORT ? Number(process.env.MINIO_PORT) : 9000,
      useSSL: (process.env.MINIO_USE_SSL ?? "false") === "true",
      accessKey: process.env.MINIO_ACCESS_KEY ?? "billy-admin",
      secretKey: process.env.MINIO_SECRET_KEY ?? "change-me-in-env",
    });
  }
  return minioClient;
};

const streamToBuffer = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
};

const resolveAttachment = async (ref: { fileId: string; filename: string }, mongo: MongoClient): Promise<{ filename: string; content: Buffer }> => {
  const db = mongo.db();
  const file = (await db
    .collection<AttachmentFileObject & { id: string; deletedAt?: unknown }>(FILES_COLLECTION)
    .findOne({ id: ref.fileId, deletedAt: null } as never, { projection: { _id: 0 } })) as
    | AttachmentFileObject
    | null;
  if (!file) {
    throw new AppError("EMAIL_DELIVERY_FAILED", `Attachment file not found: ${ref.fileId}`);
  }
  if (file.scanStatus !== "clean") {
    throw new AppError(
      "EMAIL_DELIVERY_FAILED",
      `Attachment file not scan-clean yet: ${ref.fileId} (status=${String(file.scanStatus)})`,
    );
  }
  const obj = await getMinio().getObject(FILES_BUCKET, file.objectKey);
  const content = await streamToBuffer(obj as unknown as NodeJS.ReadableStream);
  return { filename: ref.filename, content };
};

const resolveAttachments = async (refs: EmailJob["attachments"]): Promise<{ filename: string; content: Buffer }[]> => {
  if (!refs || refs.length === 0) return [];
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new AppError("EMAIL_DELIVERY_FAILED", "Cannot resolve email attachments — MONGO_URI unset");
  }
  if (!cachedClient) {
    cachedClient = new MongoClient(uri, { serverSelectionTimeoutMS: 1000 });
  }
  return Promise.all(refs.map((ref) => resolveAttachment(ref, cachedClient!)));
};

export const emailHandler = async (payload: EmailJob, ctx: ProcessorContext): Promise<unknown> => {
  const logger: Logger = ctx.logger;
  // Resolve SMTP config: DB settings → env → default. Decrypt the
  // stored password (fail-closed) before handing the pure resolver DB values.
  const dbData = await readEmailSettingsFromDb(logger);
  const decryptedPassword =
    dbData?.smtpPasswordEnc && process.env.DATA_ENCRYPTION_KEY
      ? decryptField(dbData.smtpPasswordEnc, process.env.DATA_ENCRYPTION_KEY)
      : undefined;
  const cfg = mergeSmtpConfig(dbData, process.env, decryptedPassword);
  const { transport, usingJson } = buildTransport(cfg);

  const rendered = readRendered(payload.data);
  const from = `${cfg.fromName} <${cfg.fromEmail}>`;

  // Resolve attachment REFS → bytes BEFORE sending. A missing / not-yet-clean
  // file throws here (before any send) so BullMQ retries once the PDF lands.
  const attachments = await resolveAttachments(payload.attachments);

  try {
    const info = await transport.sendMail({
      from,
      to: payload.to,
      ...(payload.cc && payload.cc.length > 0 ? { cc: payload.cc } : {}),
      ...(payload.bcc && payload.bcc.length > 0 ? { bcc: payload.bcc } : {}),
      ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    // No PII/secret logged — routing metadata only.
    logger.info(
      { queue: "email", template: payload.template, messageId: info.messageId, mode: usingJson ? "json" : "smtp" },
      "email sent",
    );
    return { messageId: info.messageId, mode: usingJson ? "json" : "smtp" };
  } catch (err) {
    logger.error(
      { queue: "email", template: payload.template, err },
      "email send failed",
    );
    // Throw so BullMQ retries; a final failure hits the DLQ /
    // failed listener. Do not leak SMTP credentials in the error.
    throw new AppError("EMAIL_DELIVERY_FAILED", "Failed to deliver email");
  } finally {
    transport.close();
  }
};
