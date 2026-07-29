import { describe, it, expect, vi } from "vitest";
import type { Logger } from "@billy/shared";
import { QUEUE_NAME_LIST, QUEUE_NAMES } from "@billy/types";
import { createProcessors, type ProcessorContext } from "@/processors.js";

/** A no-op logger stub — the framework handlers only log. */
function stubCtx(): ProcessorContext {
  const noop = vi.fn();
  const logger = { info: noop, error: noop, warn: noop, debug: noop } as unknown as Logger;
  return { logger };
}

describe("queue contract (Billy.md §27 subset)", () => {
  it("exposes the six framework queue names", () => {
    expect([...QUEUE_NAME_LIST].sort()).toEqual(
      ["backup", "cleanup", "email", "notifications", "pdf", "recurring"].sort(),
    );
  });

  it("QUEUE_NAMES values are self-mapped (name === key value)", () => {
    for (const [key, value] of Object.entries(QUEUE_NAMES)) {
      expect(value).toBe(key);
    }
  });
});

describe("processor registry", () => {
  it("registers exactly one handler per queue name", () => {
    const processors = createProcessors();
    for (const name of QUEUE_NAME_LIST) {
      expect(typeof processors[name]).toBe("function");
    }
    expect(Object.keys(processors).sort()).toEqual([...QUEUE_NAME_LIST].sort());
  });

  it("email handler sends via jsonTransport when SMTP_HOST is unset (dev)", async () => {
    // No SMTP_HOST → jsonTransport: composes + "sends" without a server.
    const prev = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
    try {
      const processors = createProcessors();
      const payload = {
        to: "a@b.com",
        template: "generic-notification",
        accountId: "biz1",
        data: { subject: "Hi", html: "<p>hello</p>", text: "hello" },
      };
      const result = (await processors.email(payload, stubCtx())) as { mode: string; messageId?: string };
      expect(result.mode).toBe("json");
    } finally {
      if (prev !== undefined) process.env.SMTP_HOST = prev;
    }
  });

  it("stub handlers resolve without a result", async () => {
    // The remaining framework stub (cleanup) logs and returns undefined; email +
    // pdf + backup + recurring + notifications are now backed by real handlers
    // (tested in their own handler test files).
    const processors = createProcessors();
    for (const name of ["cleanup"] as const) {
      const payload = {
        trigger: "manual",
        target: "orphan-files",
        accountId: "biz1",
      } as never;
      expect(await processors[name](payload, stubCtx())).toBeUndefined();
    }
  });

  it("notifications handler is wired to the real push handler (no-ops disabled without VAPID)", async () => {
    // Without VAPID keys the real push handler no-ops gracefully (disabled) rather
    // than dead-lettering — proving the stub was replaced by the handler.
    const prevPub = process.env.VAPID_PUBLIC_KEY;
    const prevPriv = process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    try {
      const processors = createProcessors();
      const result = (await processors.notifications(
        { userId: "u1", eventType: "invoice.paid", entityId: "x", accountId: "biz1" },
        stubCtx(),
      )) as { disabled?: boolean };
      expect(result.disabled).toBe(true);
    } finally {
      if (prevPub !== undefined) process.env.VAPID_PUBLIC_KEY = prevPub;
      if (prevPriv !== undefined) process.env.VAPID_PRIVATE_KEY = prevPriv;
    }
  });

  it("pdf handler is wired to the real render handler (fails fast without a doc)", async () => {
    // With the fixture id absent from any (unavailable) Mongo, the real handler
    // throws PDF_GENERATION_FAILED — proving the stub was replaced by the handler.
    const processors = createProcessors();
    await expect(
      processors.pdf({ documentType: "invoice", documentId: "does-not-exist", accountId: "biz1" }, stubCtx()),
    ).rejects.toThrow();
  });
});
