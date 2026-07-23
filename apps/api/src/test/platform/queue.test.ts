import { describe, it, expect } from "vitest";
import { buildJobId, DEFAULT_JOB_OPTIONS } from "@/platform/queue.js";
import { QUEUE_NAMES } from "@billy/types";

describe("buildJobId — deterministic idempotency keys (idempotency_spec §6)", () => {
  it("joins queue + parts with ':' in the given order", () => {
    expect(buildJobId("recurring", ["prof_123", "2026-07-15"])).toBe("recurring:prof_123:2026-07-15");
  });

  it("is stable: same inputs → same id (so retries/double-submits dedup)", () => {
    const parts = ["prof_123", "2026-07-15"] as const;
    expect(buildJobId("recurring", parts)).toBe(buildJobId("recurring", parts));
  });

  it("distinguishes different occurrences of the same profile", () => {
    expect(buildJobId("recurring", ["p1", "2026-07-15"])).not.toBe(
      buildJobId("recurring", ["p1", "2026-08-15"]),
    );
  });

  it("distinguishes the same parts across different queues", () => {
    expect(buildJobId("email", ["x"])).not.toBe(buildJobId("pdf", ["x"]));
  });

  it("namespaces every id with a real queue name", () => {
    const id = buildJobId(QUEUE_NAMES.email, ["u1"]);
    expect(id.startsWith("email:")).toBe(true);
  });
});

describe("DEFAULT_JOB_OPTIONS — retry policy (Billy.md §27.2)", () => {
  it("uses 5 attempts with exponential backoff", () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(5);
    expect(DEFAULT_JOB_OPTIONS.backoff).toEqual({ type: "exponential", delay: 1000 });
  });
});
