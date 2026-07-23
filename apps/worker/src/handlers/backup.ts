import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { JobPayloads } from "@billy/types";
import { errors } from "@billy/shared";
import type { ProcessorContext } from "@/processors.js";

const backupScriptPath = (): string => {
  // dist layout mirrors src; from apps/worker/(dist|src)/handlers → repo root.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../../scripts/backup/backup.sh");
};

/**
 * Runs the backup shell script, resolving to its exit code. Injectable so tests
 * override it directly — no global `node:child_process` mock (which would break
 * the pdf handler's real Chromium subprocess in the same test run).
 */
export type ScriptRunner = (script: string, ctx: ProcessorContext) => Promise<number>;

const defaultRunner: ScriptRunner = (script, ctx) =>
  new Promise<number>((resolvePromise) => {
    const child = spawn("sh", [script], {
      // Inherit the worker's env (MONGO_URI, MINIO_*, BACKUP_* from .env).
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (b: Buffer) => ctx.logger.info({ queue: "backup" }, b.toString().trimEnd()));
    child.stderr.on("data", (b: Buffer) => ctx.logger.warn({ queue: "backup" }, b.toString().trimEnd()));
    child.on("error", (err) => {
      ctx.logger.error({ err }, "backup script failed to spawn (mongodump/mc/openssl on PATH?)");
      resolvePromise(1);
    });
    child.on("close", (c) => resolvePromise(c ?? 1));
  });

export const backupHandler = async (payload: JobPayloads["backup"], ctx: ProcessorContext, runner: ScriptRunner = defaultRunner): Promise<{ ok: true; trigger: string }> => {
  const script = backupScriptPath();
  ctx.logger.info({ queue: "backup", trigger: payload.trigger, script }, "starting datastore backup");

  const code = await runner(script, ctx);

  if (code !== 0) {
    // Throw so BullMQ retries per the queue's retry/DLQ policy.
    throw errors.internal(`backup script exited with code ${code}`);
  }
  ctx.logger.info({ queue: "backup", trigger: payload.trigger }, "datastore backup complete");
  return { ok: true, trigger: payload.trigger };
};
