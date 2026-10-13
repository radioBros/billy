import tls from "node:tls";
import net from "node:net";
import nodemailer from "nodemailer";

export interface PecConfig {
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
  user: string;
  password: string;
}
export interface PecCheck {
  ok: boolean;
  /** Short, user-facing reason (never contains the password). */
  message?: string;
}
export interface PecTestResult {
  ok: boolean;
  smtp: PecCheck;
  imap: PecCheck;
  mail: PecCheck;
}

const clean = (e: unknown, secret: string): string => {
  const m = e instanceof Error ? e.message : String(e);
  return m.split(secret).join("***").slice(0, 200);
};

/** SMTP: verify the login, then send a real test message from the PEC mailbox. */
export const smtpCheckAndSend = async (cfg: PecConfig, to: string, subject: string, text: string): Promise<{ smtp: PecCheck; mail: PecCheck }> => {
  const transport = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpPort === 465, // implicit TLS on 465, STARTTLS (required) otherwise
    requireTLS: cfg.smtpPort !== 465,
    auth: { user: cfg.user, pass: cfg.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  try {
    try {
      await transport.verify();
    } catch (e) {
      return { smtp: { ok: false, message: clean(e, cfg.password) }, mail: { ok: false, message: "not attempted" } };
    }
    try {
      await transport.sendMail({ from: cfg.user, to, subject, text });
      return { smtp: { ok: true }, mail: { ok: true } };
    } catch (e) {
      return { smtp: { ok: true }, mail: { ok: false, message: clean(e, cfg.password) } };
    }
  } finally {
    transport.close();
  }
};

/** IMAP: connect over TLS (implicit on 993, STARTTLS otherwise), LOGIN, LOGOUT. Reads nothing. */
export const imapLoginCheck = (cfg: PecConfig, timeoutMs = 12_000): Promise<PecCheck> =>
  new Promise((resolve) => {
    let done = false;
    let stage: "greeting" | "starttls" | "login" | "logout" = "greeting";
    let buf = "";
    let sock: net.Socket | tls.TLSSocket;
    const q = (s: string): string => `"${s.replace(/(["\\])/gu, "\\$1")}"`;
    const finish = (r: PecCheck): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* closed */
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, message: "timeout" }), timeoutMs);
    const send = (line: string): void => void sock.write(`${line}\r\n`);
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\r\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (stage === "greeting" && /^\* (OK|PREAUTH)/u.test(line)) {
          if (cfg.imapPort === 993) {
            stage = "login";
            send(`a1 LOGIN ${q(cfg.user)} ${q(cfg.password)}`);
          } else {
            stage = "starttls";
            send("a0 STARTTLS");
          }
        } else if (stage === "starttls" && /^a0 OK/u.test(line)) {
          sock.removeListener("data", onData);
          sock = tls.connect({ socket: sock as net.Socket, servername: cfg.imapHost }, () => {
            stage = "login";
            send(`a1 LOGIN ${q(cfg.user)} ${q(cfg.password)}`);
          });
          sock.on("data", onData);
          sock.on("error", (e) => finish({ ok: false, message: clean(e, cfg.password) }));
        } else if (stage === "login" && /^a1 OK/u.test(line)) {
          stage = "logout";
          send("a2 LOGOUT");
          finish({ ok: true });
        } else if (/^(a0|a1) (NO|BAD)/u.test(line)) {
          finish({ ok: false, message: stage === "login" ? "login rejected (user or password)" : line.replace(cfg.password, "***").slice(0, 120) });
        }
      }
    };
    const onError = (e: Error): void => finish({ ok: false, message: clean(e, cfg.password) });
    if (cfg.imapPort === 993) {
      sock = tls.connect({ host: cfg.imapHost, port: cfg.imapPort, servername: cfg.imapHost });
    } else {
      sock = net.connect({ host: cfg.imapHost, port: cfg.imapPort });
    }
    sock.on("data", onData);
    sock.on("error", onError);
    sock.on("close", () => finish({ ok: false, message: "connection closed" }));
  });

/** SdI's own addresses must never receive a test mail (it would register as a real submission). */
export const isForbiddenTestRecipient = (to: string): boolean => /@(pec\.)?fatturapa\.it$/iu.test(to.trim());
