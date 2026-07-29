import { describe, it, expect, vi } from "vitest";
import type { Logger } from "@billy/shared";
import type { EmailJob } from "@billy/types";
import { EmailService } from "@/modules/email/service.js";
import { EMAIL_TEMPLATE_LIST, type EmailQueuePort } from "@/modules/email/types.js";
import type { EnqueueOptions } from "@/platform/queue.js";

const stubLogger = (): Logger => {
  const noop = vi.fn();
  return { info: noop, error: noop, warn: noop, debug: noop } as unknown as Logger;
};

const fakeQueue = (): {
  port: EmailQueuePort;
  calls: Array<{ name: string; payload: EmailJob; opts?: EnqueueOptions }>;
} => {
  const calls: Array<{ name: string; payload: EmailJob; opts?: EnqueueOptions }> = [];
  const port: EmailQueuePort = {
    async enqueue(name, payload, opts) {
      calls.push({ name, payload, opts });
      return "job_1";
    },
  };
  return { port, calls };
};

describe("EmailService.compose (email-service_plan EM3/EM4)", () => {
  const svc = new EmailService({ queue: fakeQueue().port, logger: stubLogger() });

  it("every template renders non-empty subject + HTML + text", () => {
    for (const template of EMAIL_TEMPLATE_LIST) {
      const msg = svc.compose(template, "client@example.com", {
        invoiceNumber: "INV-1",
        quoteNumber: "Q-1",
        amountDue: "$100.00",
        total: "$200.00",
        businessName: "Acme",
        subject: "Hi",
        body: "You have a thing.",
      });
      expect(msg.to).toBe("client@example.com");
      expect(msg.subject.length).toBeGreaterThan(0);
      expect(msg.html.length).toBeGreaterThan(0);
      expect(msg.text.length).toBeGreaterThan(0);
      expect(msg.html.startsWith("<!doctype html>")).toBe(true);
    }
  });

  it("invoice-sent includes number, amount and business", () => {
    const msg = svc.compose("invoice-sent", "c@e.com", {
      invoiceNumber: "INV-42",
      amountDue: "$500.00",
      businessName: "Acme",
    });
    expect(msg.subject).toBe("Invoice INV-42 from Acme");
    expect(msg.html).toContain("INV-42");
    expect(msg.html).toContain("$500.00");
    expect(msg.text).toContain("INV-42");
    expect(msg.text).toContain("$500.00");
  });

  it("quote-sent includes number and total", () => {
    const msg = svc.compose("quote-sent", "c@e.com", {
      quoteNumber: "Q-7",
      total: "$1,200.00",
      businessName: "Acme",
    });
    expect(msg.subject).toBe("Quote Q-7 from Acme");
    expect(msg.text).toContain("Q-7");
    expect(msg.text).toContain("$1,200.00");
  });

  it("password-reset carries the reset link", () => {
    const msg = svc.compose("password-reset", "c@e.com", {
      resetUrl: "https://app.example.com/reset?t=abc",
      expiresIn: "30 minutes",
    });
    expect(msg.subject).toBe("Reset your password");
    expect(msg.html).toContain("https://app.example.com/reset?t=abc");
    expect(msg.text).toContain("30 minutes");
  });

  it("email-verification carries the verify link and code", () => {
    const msg = svc.compose("email-verification", "c@e.com", {
      verifyUrl: "https://app.example.com/verify?t=xyz",
      code: "123456",
    });
    expect(msg.subject).toBe("Verify your email address");
    expect(msg.html).toContain("123456");
    expect(msg.text).toContain("https://app.example.com/verify?t=xyz");
  });

  it("generic-notification uses provided subject/body/action", () => {
    const msg = svc.compose("generic-notification", "c@e.com", {
      subject: "Payment received",
      body: "We received your payment.",
      actionUrl: "https://app.example.com/invoices/1",
      actionLabel: "View invoice",
    });
    expect(msg.subject).toBe("Payment received");
    expect(msg.html).toContain("We received your payment.");
    expect(msg.html).toContain("View invoice");
    expect(msg.text).toContain("https://app.example.com/invoices/1");
  });

  it("escapes HTML in variables (no markup injection)", () => {
    const msg = svc.compose("generic-notification", "c@e.com", {
      subject: "x",
      body: "<script>alert(1)</script>",
    });
    expect(msg.html).not.toContain("<script>");
    expect(msg.html).toContain("&lt;script&gt;");
  });

  it("renders a non-en locale (de) with localized prose and escaped vars", () => {
    const msg = svc.compose(
      "invoice-sent",
      "kunde@example.com",
      { invoiceNumber: "INV-<7>", amountDue: "500,00 €", businessName: "Acme GmbH" },
      "de",
    );
    // German subject pattern: "Rechnung {number} von {business}".
    expect(msg.subject).toBe("Rechnung INV-<7> von Acme GmbH");
    // German body prose present.
    expect(msg.html).toContain("hat Ihnen die Rechnung");
    expect(msg.text).toContain("hat Ihnen die Rechnung");
    // Vars are still HTML-escaped in the HTML body (< > become entities).
    expect(msg.html).toContain("INV-&lt;7&gt;");
    expect(msg.html).not.toContain("INV-<7>");
    // Text body keeps the raw (unescaped) var.
    expect(msg.text).toContain("INV-<7>");
  });

  it("localizes password-reset subject per locale", () => {
    expect(svc.compose("password-reset", "c@e.com", {}, "fr").subject).toBe(
      "Réinitialisez votre mot de passe",
    );
    expect(svc.compose("password-reset", "c@e.com", {}, "es").subject).toBe(
      "Restablezca su contraseña",
    );
  });

  it("falls back to en for an unknown locale (never throws)", () => {
    const bogus = "zz" as unknown as Parameters<typeof svc.compose>[3];
    const msg = svc.compose(
      "invoice-sent",
      "c@e.com",
      { invoiceNumber: "INV-1", amountDue: "$1.00", businessName: "Acme" },
      bogus,
    );
    // Identical to the en render.
    expect(msg.subject).toBe("Invoice INV-1 from Acme");
    expect(msg.html).toContain("has sent you invoice");
  });
});

describe("EmailService.send (EM2 — enqueue, no inline send)", () => {
  it("enqueues onto the email queue with rendered subject/html/text in data", async () => {
    const q = fakeQueue();
    const svc = new EmailService({ queue: q.port, logger: stubLogger() });

    const jobId = await svc.send({
      to: "client@example.com",
      template: "invoice-sent",
      data: { invoiceNumber: "INV-9", amountDue: "$10.00", businessName: "Acme" },
      accountId: "biz_1",
    });

    expect(jobId).toBe("job_1");
    expect(q.calls).toHaveLength(1);
    const call = q.calls[0]!;
    expect(call.name).toBe("email");
    expect(call.payload.to).toBe("client@example.com");
    expect(call.payload.template).toBe("invoice-sent");
    expect(call.payload.accountId).toBe("biz_1");
    // Rendered content is carried in data for the worker.
    expect(call.payload.data?.subject).toBe("Invoice INV-9 from Acme");
    expect(String(call.payload.data?.html)).toContain("INV-9");
    expect(String(call.payload.data?.text)).toContain("$10.00");
  });

  it("passes idempotencyParts through to the queue", async () => {
    const q = fakeQueue();
    const svc = new EmailService({ queue: q.port, logger: stubLogger() });

    await svc.send({
      to: "c@e.com",
      template: "quote-sent",
      accountId: "biz_1",
      idempotencyParts: ["quote_5", "sent"],
    });

    expect(q.calls[0]!.opts?.idempotencyParts).toEqual(["quote_5", "sent"]);
  });

  it("threads the locale through to the composed message", async () => {
    const q = fakeQueue();
    const svc = new EmailService({ queue: q.port, logger: stubLogger() });

    await svc.send({
      to: "kunde@example.com",
      template: "invoice-sent",
      data: { invoiceNumber: "INV-9", amountDue: "10,00 €", businessName: "Acme GmbH" },
      accountId: "biz_1",
      locale: "de",
    });

    expect(String(q.calls[0]!.payload.data?.subject)).toBe("Rechnung INV-9 von Acme GmbH");
  });
});
