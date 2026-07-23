import { describe, it, expect } from "vitest";
import type { Logger } from "@billy/shared";
import type { ProcessorContext } from "@/processors.js";
import { backupHandler, type ScriptRunner } from "@/handlers/backup.js";

const stubCtx = (): ProcessorContext => {
  const noop = () => undefined;
  const logger = { info: noop, error: noop, warn: noop, debug: noop } as unknown as Logger;
  return { logger };
};

describe("backupHandler (invokes scripts/backup/backup.sh via injected runner)", () => {
  it("resolves ok + targets the backup script when the runner exits 0", async () => {
    let seenScript = "";
    const runner: ScriptRunner = (script) => {
      seenScript = script;
      return Promise.resolve(0);
    };
    const result = await backupHandler({ trigger: "manual", accountId: "b1" }, stubCtx(), runner);
    expect(result).toEqual({ ok: true, trigger: "manual" });
    expect(seenScript).toMatch(/scripts\/backup\/backup\.sh$/u);
  });

  it("throws INTERNAL_ERROR (retryable) when the runner exits non-zero", async () => {
    const runner: ScriptRunner = () => Promise.resolve(1);
    await expect(
      backupHandler({ trigger: "scheduled", accountId: "b1" }, stubCtx(), runner),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});
