import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { signPassoWebhook, verifyPassoWebhook } from "../webhook.js";
import { fromPassoState, isLegallyIssued, pollIntervalSec, canRetry } from "../status.js";
import { PassoClient, PassoError, type FetchLike } from "../passo-client.js";

describe("verifyPassoWebhook", () => {
  const body = '{"eventId":"e1"}';
  const now = 1_800_000_000;
  it("accepts a valid signature, either value during rotation", () => {
    const h = signPassoWebhook(body, "whsec_new", now);
    expect(verifyPassoWebhook(h, body, "whsec_new", now)).toBe("ok");
    const old = createHmac("sha256", "whsec_old").update(`${now}.${body}`).digest("hex");
    const rotating = `${h},v1=${old}`;
    expect(verifyPassoWebhook(rotating, body, "whsec_old", now)).toBe("ok");
    expect(verifyPassoWebhook(rotating, body, "whsec_new", now)).toBe("ok");
  });
  it("rejects tampering, wrong secret, stale timestamps and junk", () => {
    const h = signPassoWebhook(body, "s", now);
    expect(verifyPassoWebhook(h, body + " ", "s", now)).toBe("bad_signature");
    expect(verifyPassoWebhook(h, body, "other", now)).toBe("bad_signature");
    expect(verifyPassoWebhook(h, body, "s", now + 301)).toBe("stale");
    expect(verifyPassoWebhook(undefined, body, "s", now)).toBe("missing_header");
    expect(verifyPassoWebhook("garbage", body, "s", now)).toBe("malformed");
  });
});

describe("status", () => {
  it("maps PASSO states and legal-issue semantics", () => {
    expect(fromPassoState("transmitting")).toBe("queued");
    expect(fromPassoState("awaiting_delivery")).toBe("awaiting_delivery");
    expect(isLegallyIssued("awaiting_delivery")).toBe(true); // MC: issued, do not resubmit
    expect(isLegallyIssued("rejected")).toBe(false); // NS: legally not issued
    expect(canRetry("failed")).toBe(true);
    expect(canRetry("rejected")).toBe(false);
  });
  it("polls in-flight fast, MC daily, finals never", () => {
    expect(pollIntervalSec("queued", 120)).toBe(120);
    expect(pollIntervalSec("awaiting_delivery", 120)).toBe(86400);
    expect(pollIntervalSec("delivered", 120)).toBeNull();
  });
});

describe("PassoClient", () => {
  const mk = (status: number, body: unknown): { client: PassoClient; calls: { url: string; init: Parameters<FetchLike>[1] }[] } => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const f: FetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({ status, text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)) });
    };
    return { client: new PassoClient({ baseUrl: "http://passo-api:3000/", apiKey: "passo_live_x", adminKey: "adm", fetch: f }), calls };
  };
  it("submits with bearer auth and the idempotency key", async () => {
    const { client, calls } = mk(202, { submissionId: "s1", status: "queued", invoiceNumber: "1", progressivoInvio: "0001P", fileName: "f.xml" });
    const r = await client.submit({ sellerId: "x", crmInvoiceRef: "r", mode: "async", invoice: {} as never }, "k1");
    expect(r.submissionId).toBe("s1");
    expect(calls[0]!.url).toBe("http://passo-api:3000/api/v1/invoices");
    expect(calls[0]!.init.headers).toMatchObject({ authorization: "Bearer passo_live_x", "idempotency-key": "k1" });
  });
  it("parses the error envelope and classifies transient vs permanent", async () => {
    const { client } = mk(422, { error: { code: "ERR_XSD_INVALID", message: "bad", retryable: false, details: [{ path: "a" }] } });
    const e = await client.get("s1").catch((x: unknown) => x as PassoError);
    expect(e).toBeInstanceOf(PassoError);
    expect(e).toMatchObject({ status: 422, code: "ERR_XSD_INVALID", transient: false });
    // PASSO's duplicate-number 500 claims retryable:true — billy must NOT treat a 500 as transient.
    const dup = mk(500, { error: { code: "ERR_INTERNAL", message: "x", retryable: true } });
    const d = await dup.client.get("s1").catch((x: unknown) => x as PassoError);
    expect(d).toMatchObject({ status: 500, code: "ERR_INTERNAL", transient: false });
    expect(await mk(503, "").client.get("s").catch((x: unknown) => (x as PassoError).transient)).toBe(true);
  });
  it("refuses to call without credentials", async () => {
    const c = new PassoClient({ baseUrl: "http://x" });
    await expect(c.get("s")).rejects.toMatchObject({ code: "BILLY_NO_CREDENTIALS" });
  });
});
