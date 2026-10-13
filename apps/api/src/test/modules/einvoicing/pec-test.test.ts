import { describe, it, expect } from "vitest";
import net from "node:net";
import { imapLoginCheck, isForbiddenTestRecipient, type PecConfig } from "@/modules/einvoicing/pec-test.js";

const listen = (handler: (s: net.Socket) => void): Promise<{ port: number; close: () => void }> =>
  new Promise((resolve) => {
    const srv = net.createServer(handler).listen(0, "127.0.0.1", () => resolve({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close() }));
  });
const cfg = (port: number): PecConfig => ({ smtpHost: "127.0.0.1", smtpPort: 587, imapHost: "127.0.0.1", imapPort: port, user: "me@pec.it", password: "s3cret" });

describe("imapLoginCheck (failure paths; the success path needs a real TLS mailbox)", () => {
  it("reports a refused connection without throwing or leaking the password", async () => {
    const r = await imapLoginCheck(cfg(1), 3000);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("s3cret");
  });

  it("reports a server that refuses STARTTLS (never sends credentials in clear)", async () => {
    const seen: string[] = [];
    const srv = await listen((s) => {
      s.write("* OK IMAP ready\r\n");
      s.on("data", (d) => {
        seen.push(d.toString());
        s.write("a0 NO STARTTLS not available\r\n");
      });
    });
    const r = await imapLoginCheck(cfg(srv.port), 3000);
    srv.close();
    expect(r.ok).toBe(false);
    expect(seen.join("")).toContain("a0 STARTTLS");
    expect(seen.join("")).not.toContain("LOGIN");
    expect(seen.join("")).not.toContain("s3cret");
  });

  it("times out on a silent server", async () => {
    const srv = await listen(() => undefined);
    const r = await imapLoginCheck(cfg(srv.port), 400);
    srv.close();
    expect(r).toMatchObject({ ok: false, message: "timeout" });
  });
});

describe("isForbiddenTestRecipient", () => {
  it("blocks SdI addresses only", () => {
    expect(isForbiddenTestRecipient("sdi01@pec.fatturapa.it")).toBe(true);
    expect(isForbiddenTestRecipient("x@fatturapa.it")).toBe(true);
    expect(isForbiddenTestRecipient("me@example.com")).toBe(false);
  });
});
