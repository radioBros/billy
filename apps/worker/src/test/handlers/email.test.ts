import { describe, it, expect, vi, afterEach } from "vitest";
import type { Logger } from "@billy/shared";
import type { EmailJob } from "@billy/types";
import nodemailer from "nodemailer";
import { emailHandler, buildTransport, mergeSmtpConfig } from "@/handlers/email.js";
import type { ProcessorContext } from "@/processors.js";

const stubCtx = (): ProcessorContext => {
  const noop = vi.fn();
  const logger = { info: noop, error: noop, warn: noop, debug: noop } as unknown as Logger;
  return { logger };
};

const SMTP_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USERNAME",
  "SMTP_PASSWORD",
  "SMTP_FROM_EMAIL",
  "SMTP_FROM_NAME",
  // Cleared so `emailHandler` cannot pick up a real Mongo (DB→env→default): with
  // MONGO_URI unset the DB read early-returns null and the tests stay hermetic
  // (the resolver falls to env → default → jsonTransport). Also clears the
  // decryption key so no DB-password path is attempted.
  "MONGO_URI",
  "DATA_ENCRYPTION_KEY",
] as const;

const saved: Record<string, string | undefined> = {};
for (const k of SMTP_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of SMTP_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("emailHandler (worker send — jsonTransport dev fallback)", () => {
  it("builds the message and 'sends' via jsonTransport with no SMTP server", async () => {
    for (const k of SMTP_KEYS) delete process.env[k];

    const payload: EmailJob = {
      to: "client@example.com",
      template: "invoice-sent",
      accountId: "biz_1",
      data: { subject: "Invoice INV-1", html: "<p>Invoice INV-1</p>", text: "Invoice INV-1" },
    };

    const result = (await emailHandler(payload, stubCtx())) as {
      mode: string;
      messageId?: string;
    };

    expect(result.mode).toBe("json");
    // jsonTransport assigns a messageId even without a real send.
    expect(typeof result.messageId).toBe("string");
  });

  it("builds the message (to/subject/html/text) via jsonTransport", async () => {
    // jsonTransport composes the message and returns it as JSON on info.message,
    // proving the message was BUILT correctly without a server.
    const { transport, usingJson } = buildTransport({
      host: undefined,
      port: 587,
      secure: false,
      fromEmail: "no-reply@billy.local",
      fromName: "Billy",
    });
    expect(usingJson).toBe(true);
    try {
      const info = await transport.sendMail({
        from: "Billy <no-reply@billy.local>",
        to: "client@example.com",
        subject: "Invoice INV-1",
        html: "<p>Invoice INV-1</p>",
        text: "Invoice INV-1 text",
      });
      const built = JSON.parse(info.message) as {
        to: Array<{ address: string }> | string;
        subject: string;
        html: string;
        text: string;
      };
      expect(built.subject).toBe("Invoice INV-1");
      expect(built.html).toContain("Invoice INV-1");
      expect(built.text).toContain("Invoice INV-1 text");
      expect(JSON.stringify(built.to)).toContain("client@example.com");
    } finally {
      transport.close();
    }
  });

  it("does not throw when data is empty (renders empty message)", async () => {
    for (const k of SMTP_KEYS) delete process.env[k];
    const payload: EmailJob = {
      to: "c@e.com",
      template: "generic-notification",
      accountId: "biz_1",
    };
    const result = (await emailHandler(payload, stubCtx())) as { mode: string };
    expect(result.mode).toBe("json");
  });

  it("emailHandler passes cc/bcc/replyTo from the payload to sendMail", async () => {
    for (const k of SMTP_KEYS) delete process.env[k];
    // Spy on the transport so we inspect the ACTUAL options the handler builds
    // (exercises the handler's cc/bcc/replyTo spreads, not just nodemailer).
    const sendMail = vi.fn().mockResolvedValue({ messageId: "mid-1" });
    const close = vi.fn();
    const spy = vi
      .spyOn(nodemailer, "createTransport")
      .mockReturnValue({ sendMail, close } as unknown as ReturnType<typeof nodemailer.createTransport>);
    try {
      const payload: EmailJob = {
        to: "client@example.com",
        cc: ["cc@example.com"],
        bcc: ["bcc@example.com"],
        replyTo: "reply@example.com",
        template: "invoice-sent",
        accountId: "biz_1",
        data: { subject: "S", html: "<p>H</p>", text: "T" },
      };
      await emailHandler(payload, stubCtx());
      expect(sendMail).toHaveBeenCalledTimes(1);
      const opts = sendMail.mock.calls[0]![0] as Record<string, unknown>;
      expect(opts.to).toBe("client@example.com");
      expect(opts.cc).toEqual(["cc@example.com"]);
      expect(opts.bcc).toEqual(["bcc@example.com"]);
      expect(opts.replyTo).toBe("reply@example.com");
      // No attachments on the payload → none in the options.
      expect(opts.attachments).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("THROWS (retry) when an attachment ref cannot be resolved (MONGO_URI unset)", async () => {
    for (const k of SMTP_KEYS) delete process.env[k];
    // With MONGO_URI unset, attachment resolution cannot proceed → the handler
    // throws before sending so BullMQ retries once storage/DB are reachable.
    const payload: EmailJob = {
      to: "client@example.com",
      template: "invoice-sent",
      accountId: "biz_1",
      data: { subject: "S", html: "<p>H</p>", text: "T" },
      attachments: [{ fileId: "file-1", filename: "invoice.pdf" }],
    };
    await expect(emailHandler(payload, stubCtx())).rejects.toMatchObject({
      code: "EMAIL_DELIVERY_FAILED",
    });
  });
});

// ── Config precedence resolver (CUST-5/CUST-8: DB → env → default) ────────────

describe("mergeSmtpConfig — DB → env → default precedence", () => {
  const emptyEnv: NodeJS.ProcessEnv = {};

  it("no DB doc, no env → built-in defaults (no host → jsonTransport)", () => {
    const cfg = mergeSmtpConfig(null, emptyEnv);
    expect(cfg.host).toBeUndefined();
    expect(cfg.port).toBe(587);
    expect(cfg.secure).toBe(false);
    expect(cfg.fromEmail).toBe("no-reply@billy.local");
    expect(cfg.fromName).toBe("Billy");
    // No host resolved → jsonTransport (the existing-test invariant).
    expect(buildTransport(cfg).usingJson).toBe(true);
  });

  it("no DB doc → env values are used (env over default)", () => {
    const env: NodeJS.ProcessEnv = {
      SMTP_HOST: "smtp.env.example",
      SMTP_PORT: "2525",
      SMTP_SECURE: "true",
      SMTP_USERNAME: "envuser",
      SMTP_PASSWORD: "envpass",
      SMTP_FROM_EMAIL: "env@example.com",
      SMTP_FROM_NAME: "EnvSender",
    };
    const cfg = mergeSmtpConfig(null, env);
    expect(cfg.host).toBe("smtp.env.example");
    expect(cfg.port).toBe(2525);
    expect(cfg.secure).toBe(true);
    expect(cfg.username).toBe("envuser");
    expect(cfg.password).toBe("envpass");
    expect(cfg.fromEmail).toBe("env@example.com");
    expect(cfg.fromName).toBe("EnvSender");
    expect(buildTransport(cfg).usingJson).toBe(false);
  });

  it("DB doc with a host → DB wins over env for the connection", () => {
    const env: NodeJS.ProcessEnv = {
      SMTP_HOST: "smtp.env.example",
      SMTP_PORT: "2525",
      SMTP_USERNAME: "envuser",
      SMTP_PASSWORD: "envpass",
    };
    const cfg = mergeSmtpConfig(
      {
        smtpHost: "smtp.db.example",
        smtpPort: 465,
        smtpSecure: true,
        smtpUsername: "dbuser",
        smtpPasswordEnc: "v1:x:y:z",
        fromEmail: "db@example.com",
      },
      env,
      "decrypted-db-pass",
    );
    expect(cfg.host).toBe("smtp.db.example");
    expect(cfg.port).toBe(465);
    expect(cfg.secure).toBe(true);
    expect(cfg.username).toBe("dbuser");
    // Uses the caller-decrypted password, never the ciphertext.
    expect(cfg.password).toBe("decrypted-db-pass");
    expect(cfg.fromEmail).toBe("db@example.com");
  });

  it("DB doc WITHOUT a host → falls through to env (DB not authoritative)", () => {
    const env: NodeJS.ProcessEnv = { SMTP_HOST: "smtp.env.example", SMTP_PORT: "2525" };
    const cfg = mergeSmtpConfig({ smtpHost: null, fromName: "DBName" }, env);
    // env host wins (DB has no host), but DB fromName is preferred where set.
    expect(cfg.host).toBe("smtp.env.example");
    expect(cfg.port).toBe(2525);
    expect(cfg.fromName).toBe("DBName");
  });
});
