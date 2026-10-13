import { createHash, randomBytes } from "node:crypto";
import { MongoClient, type Db } from "mongodb";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { loadConfig } from "@billy/config";
import type { EInvoiceJob } from "@billy/types";
import {
  MAX_POLL_DAYS,
  MC_POLL_DAYS,
  PassoClient,
  PassoError,
  daysBetweenIso,
  decryptSecret,
  evaluateDocument,
  fromPassoState,
  isFinalStatus,
  isLegallyIssued,
  normalizeEInvoicingSettings,
  pollIntervalSec,
  todayInZone,
  type DocKind,
  type EInvoiceStatus,
  type EInvoiceSubmissionDoc,
  type EInvoicingSettingsData,
  type PassoSubmission,
  type RawBusinessLike,
  type RawInvoiceLike,
} from "@billy/einvoice";
import type { ProcessorContext } from "@/processors.js";

/**
 * Italian e-invoicing handler (PASSO relay). Worker is the ONLY submitter:
 *  - `submit`: re-run the shared readiness check, map, POST to PASSO (idempotency key per
 *    attempt), record the submission, archive the XML immediately (PASSO purges its copy
 *    shortly after the final receipt; billy is the system of record).
 *  - `retry`:  re-run a PASSO `failed` submission on the SAME submission (same ProgressivoInvio).
 *    A `transmitting` submission is NEVER retried automatically (the vendor may already
 *    hold it; a repeat would be rejected as a duplicate).
 *  - `sync`:   pull state + receipts, ack stored receipts, refresh the document's `einvoice`
 *    state, back off polling (MC daily, stop after MC_POLL_DAYS / MAX_POLL_DAYS).
 *  - `tick`:   repeatable fan-out, one `sync` job per account with due submissions.
 *
 * The worker cannot import API code; everything shared lives in `@billy/einvoice`.
 */

const SUBMISSIONS = "einvoiceSubmissions";
const SETTINGS = "settings";

// ── Lazy connections (mirror handlers/recurring.ts) ───────────────────────────
let cachedClient: MongoClient | null = null;
const getDb = async (): Promise<Db> => {
  const cfg = loadConfig();
  if (!cachedClient) {
    cachedClient = new MongoClient(cfg.MONGO_URI, { serverSelectionTimeoutMS: 2000 });
    await cachedClient.connect();
  }
  return cachedClient.db();
};
let cachedRedis: Redis | null = null;
let cachedQueue: Queue | null = null;
const einvoiceQueue = (): Queue => {
  if (!cachedQueue) {
    const cfg = loadConfig();
    cachedRedis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
    cachedQueue = new Queue("einvoice", {
      connection: cachedRedis,
      defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: { age: 3600, count: 500 }, removeOnFail: { age: 7 * 24 * 3600 } },
    });
  }
  return cachedQueue;
};

/** Enqueue a `submit` from the worker's scheduled/recurring scans. Best-effort, deduped per document. */
export const enqueueEInvoiceSubmit = async (
  accountId: string,
  docKind: DocKind,
  docId: string,
  trigger: "scheduled" | "recurring",
): Promise<void> => {
  const job: EInvoiceJob = { kind: "submit", accountId, docKind, docId, trigger };
  await einvoiceQueue().add("einvoice-submit", job, { jobId: `einvoice-submit-${docKind}-${docId}` });
};

const nowIso = (): string => new Date().toISOString();
const newId = (): string => randomBytes(12).toString("hex");
const addSeconds = (iso: string, s: number): string => new Date(Date.parse(iso) + s * 1000).toISOString();

interface DocLike extends RawInvoiceLike {
  id: string;
  accountId: string;
  status: string;
  clientId?: string;
  creditedInvoiceId?: string;
  updatedAt?: string;
  einvoice?: { status?: EInvoiceStatus; currentSubmissionId?: string | null; submitOnFinalize?: boolean } | null;
  finalizedAt?: string | null;
}

const collectionFor = (kind: DocKind): string => (kind === "credit_note" ? "creditNotes" : "invoices");
/** Document statuses from which a document may be sent to SdI. */
const SENDABLE: Record<DocKind, readonly string[]> = {
  invoice: ["finalized", "sent", "partially_paid", "paid"],
  credit_note: ["issued"],
};

interface AccountCtx {
  settings: EInvoicingSettingsData;
  business: RawBusinessLike & { timezone?: string | null };
  client: PassoClient | null;
  baseUrl: string | null;
}

const loadAccount = async (db: Db, accountId: string): Promise<AccountCtx> => {
  const [einv, biz] = await Promise.all([
    db.collection(SETTINGS).findOne({ key: "einvoicing", accountId } as never, { projection: { _id: 0 } }),
    db.collection(SETTINGS).findOne({ key: "business", accountId } as never, { projection: { _id: 0 } }),
  ]);
  const settings = normalizeEInvoicingSettings((einv as { data?: Partial<EInvoicingSettingsData> } | null)?.data);
  const business = ((biz as { data?: RawBusinessLike & { timezone?: string | null } } | null)?.data ?? { businessName: "" }) as AccountCtx["business"];
  const cfg = loadConfig();
  const baseUrl = settings.apiBaseUrl || cfg.PASSO_API_URL || null;
  let client: PassoClient | null = null;
  if (baseUrl && settings.apiKeyEnc) {
    try {
      client = new PassoClient({ baseUrl, apiKey: decryptSecret(settings.apiKeyEnc, cfg.DATA_ENCRYPTION_KEY) });
    } catch {
      client = null; // unreadable key → treated as not connected
    }
  }
  return { settings, business, client, baseUrl };
};

const setDocState = async (db: Db, kind: DocKind, accountId: string, docId: string, patch: Record<string, unknown>): Promise<void> => {
  const $set: Record<string, unknown> = { updatedAt: nowIso() };
  for (const [k, v] of Object.entries(patch)) $set[`einvoice.${k}`] = v;
  await db.collection(collectionFor(kind)).updateOne({ id: docId, accountId } as never, { $set } as never);
};

const errInfo = (e: unknown): { code: string; message: string } =>
  e instanceof PassoError ? { code: e.code, message: e.message.slice(0, 300) } : { code: "BILLY_ERROR", message: (e instanceof Error ? e.message : "error").slice(0, 300) };

// ── submit ────────────────────────────────────────────────────────────────────
const submit = async (job: Extract<EInvoiceJob, { kind: "submit" }>, ctx: ProcessorContext): Promise<unknown> => {
  const db = await getDb();
  const { accountId, docKind, docId } = job;
  const acct = await loadAccount(db, accountId);
  if (!acct.settings.enabled) {
    ctx.logger.info({ accountId, docId }, "einvoice submit skipped: integration disabled");
    return { skipped: "disabled" };
  }
  const docs = db.collection<DocLike>(collectionFor(docKind));
  const doc = (await docs.findOne({ id: docId, accountId, deletedAt: null } as never, { projection: { _id: 0 } })) as DocLike | null;
  if (!doc) return { skipped: "not_found" };
  if (!SENDABLE[docKind].includes(doc.status)) return { skipped: "not_sendable" };
  const cur = doc.einvoice?.status ?? "not_sent";
  // Claimed-but-unsent ("queued" with no submission yet) is re-entrant for BullMQ retries.
  const reentrant = cur === "queued" && !doc.einvoice?.currentSubmissionId;
  if (!reentrant && cur !== "not_sent" && cur !== "blocked") return { skipped: `status_${cur}` };

  if (docKind === "credit_note" && doc.creditedInvoiceId) {
    const inv = (await db.collection("invoices").findOne({ id: doc.creditedInvoiceId, accountId } as never, { projection: { _id: 0, invoiceNumber: 1, issueDate: 1 } })) as { invoiceNumber?: string; issueDate?: string } | null;
    doc.creditedInvoiceNumber = inv?.invoiceNumber ?? doc.creditedInvoiceNumber ?? null;
    doc.creditedIssueDate = inv?.issueDate ?? null;
  }

  const today = todayInZone(acct.business.timezone ?? "Europe/Rome");
  const ev = evaluateDocument({
    kind: docKind,
    doc,
    business: acct.business,
    settings: acct.settings,
    envApiUrl: acct.baseUrl,
    today,
    docFinalizedAt: doc.finalizedAt ?? null,
    crmInvoiceRef: `billy:${accountId}:${docId}`,
  });
  if (!ev.ok || !ev.body || !acct.client) {
    const first = ev.issues.find((i) => i.severity === "error");
    await setDocState(db, docKind, accountId, docId, {
      status: "blocked",
      legallyIssued: false,
      lastError: { code: first?.code ?? "einvoicing.not_connected", message: ev.issues.filter((i) => i.severity === "error").map((i) => i.code).join(", ") || "not connected" },
      lastEventAt: nowIso(),
    });
    ctx.logger.warn({ accountId, docId, trigger: job.trigger, issues: ev.issues.map((i) => i.code) }, "einvoice blocked by preflight");
    return { blocked: true };
  }

  // Claim (idempotent for retries) before talking to PASSO.
  await setDocState(db, docKind, accountId, docId, { status: "queued", legallyIssued: false, lastError: null });

  const subs = db.collection<EInvoiceSubmissionDoc>(SUBMISSIONS);
  const attempt = (await subs.countDocuments({ accountId, docKind, docId } as never)) + 1;
  const idempotencyKey = `billy:${accountId}:${docId}:${attempt}`;
  const payloadSha256 = createHash("sha256").update(JSON.stringify(ev.body.invoice)).digest("hex");

  let accepted;
  try {
    accepted = await acct.client.submit(ev.body, idempotencyKey);
  } catch (e) {
    const info = errInfo(e);
    if (e instanceof PassoError && e.transient) {
      ctx.logger.warn({ accountId, docId, code: info.code }, "einvoice submit transient failure — BullMQ will retry");
      throw e; // keeps status "queued"; the retry is idempotent via the key
    }
    // Permanent (validation/XSD/duplicate number/auth…): nothing was accepted by PASSO.
    await setDocState(db, docKind, accountId, docId, { status: "blocked", lastError: info, lastEventAt: nowIso() });
    ctx.logger.error({ accountId, docId, ...info, details: e instanceof PassoError ? e.details : undefined }, "einvoice submit rejected by PASSO");
    return { blocked: true };
  }

  const ts = nowIso();
  const row: EInvoiceSubmissionDoc = {
    id: newId(),
    accountId,
    docKind,
    docId,
    attempt,
    idempotencyKey,
    passoSubmissionId: accepted.submissionId,
    progressivoInvio: accepted.progressivoInvio,
    fileName: accepted.fileName,
    payloadSha256,
    status: "queued",
    trigger: job.trigger,
    receipts: [],
    nextSyncAt: addSeconds(ts, 15),
    pollingDone: false,
    createdAt: ts,
    updatedAt: ts,
  };
  await subs.insertOne({ ...row, deletedAt: null } as never);
  await setDocState(db, docKind, accountId, docId, {
    status: "queued",
    legallyIssued: false,
    currentSubmissionId: row.id,
    fileName: accepted.fileName,
    submittedAt: ts,
    lastEventAt: ts,
    lastError: null,
  });
  await archiveXml(db, acct.client, row, ctx);
  await einvoiceQueue().add("einvoice-sync", { kind: "sync", accountId, submissionId: row.id } satisfies EInvoiceJob, { delay: 15_000, jobId: `einvoice-sync-${row.id}-${Date.now()}` });
  ctx.logger.info({ accountId, docId, submissionId: accepted.submissionId, attempt }, "einvoice accepted by PASSO");
  return { submissionId: accepted.submissionId };
};

/** Fetch the final XML from PASSO and keep it (idempotent; best-effort — sync retries later). */
const archiveXml = async (db: Db, client: PassoClient, row: EInvoiceSubmissionDoc, ctx: ProcessorContext): Promise<void> => {
  try {
    const exp = await client.exportInvoice(row.passoSubmissionId);
    if (!exp.xml) return;
    const sha = createHash("sha256").update(exp.xml).digest("hex");
    await db.collection(SUBMISSIONS).updateOne({ id: row.id, accountId: row.accountId } as never, { $set: { xml: exp.xml, xmlSha256: exp.hashes?.xmlSha256 ?? sha, archivedAt: nowIso(), updatedAt: nowIso() } } as never);
    row.xml = exp.xml;
  } catch (e) {
    ctx.logger.warn({ submissionId: row.passoSubmissionId, ...errInfo(e) }, "einvoice XML archive deferred (sync will retry)");
  }
};

// ── retry ─────────────────────────────────────────────────────────────────────
const retry = async (job: Extract<EInvoiceJob, { kind: "retry" }>, ctx: ProcessorContext): Promise<unknown> => {
  const db = await getDb();
  const { accountId, docKind, docId } = job;
  const acct = await loadAccount(db, accountId);
  if (!acct.settings.enabled || !acct.client) return { skipped: "not_connected" };
  const subs = db.collection<EInvoiceSubmissionDoc>(SUBMISSIONS);
  const last = (await subs.find({ accountId, docKind, docId } as never).sort({ attempt: -1 }).limit(1).toArray())[0];
  if (!last || last.status !== "failed") return { skipped: "not_failed" };
  try {
    await acct.client.retry(last.passoSubmissionId);
  } catch (e) {
    const info = errInfo(e);
    await setDocState(db, docKind, accountId, docId, { lastError: info, lastEventAt: nowIso() });
    if (e instanceof PassoError && e.transient) throw e;
    return { failed: info };
  }
  const ts = nowIso();
  await subs.updateOne({ id: last.id, accountId } as never, { $set: { status: "queued", pollingDone: false, nextSyncAt: addSeconds(ts, 15), updatedAt: ts, lastError: null } } as never);
  await setDocState(db, docKind, accountId, docId, { status: "queued", lastError: null, lastEventAt: ts });
  await einvoiceQueue().add("einvoice-sync", { kind: "sync", accountId, submissionId: last.id } satisfies EInvoiceJob, { delay: 15_000, jobId: `einvoice-sync-${last.id}-${Date.now()}` });
  ctx.logger.info({ accountId, docId, submissionId: last.passoSubmissionId }, "einvoice retry requested");
  return { retried: true };
};

// ── sync ──────────────────────────────────────────────────────────────────────
const syncOne = async (db: Db, acct: AccountCtx, row: EInvoiceSubmissionDoc, ctx: ProcessorContext): Promise<void> => {
  const subs = db.collection<EInvoiceSubmissionDoc>(SUBMISSIONS);
  const client = acct.client;
  if (!client) return;
  let remote: PassoSubmission;
  try {
    remote = await client.get(row.passoSubmissionId);
  } catch (e) {
    const info = errInfo(e);
    ctx.logger.warn({ submissionId: row.passoSubmissionId, ...info }, "einvoice sync: PASSO read failed");
    await subs.updateOne({ id: row.id, accountId: row.accountId } as never, { $set: { nextSyncAt: addSeconds(nowIso(), 300), updatedAt: nowIso(), lastError: info } } as never);
    return;
  }
  const ts = nowIso();
  let status: EInvoiceStatus = fromPassoState(remote.status);
  // A PASSO row stuck in "transmitting" for long is outcome-unknown: never auto-retry; surface it.
  const ageMin = (Date.parse(ts) - Date.parse(row.createdAt)) / 60000;
  let lastError = row.lastError ?? null;
  if (remote.status === "transmitting" && ageMin > 15) {
    lastError = { code: "OUTCOME_UNKNOWN", message: "Delivery to the channel is unconfirmed; contact the PASSO operator before retrying." };
  } else if (status !== "failed") {
    lastError = null;
  } else {
    lastError = { code: "SUBMISSION_FAILED", message: "PASSO could not hand the invoice to the channel after its automatic attempts. Fix the cause (e.g. channel credit/credentials) and retry." };
  }

  // Merge receipts (dedupe by type+receivedAt) and keep SdI error details.
  const receipts = [...row.receipts];
  const fresh: string[] = [];
  for (const n of remote.notifications ?? []) {
    if (receipts.some((r) => r.type === n.type && r.receivedAt === n.receivedAt)) continue;
    receipts.push({ type: n.type, receivedAt: n.receivedAt, ...(n.errors?.length ? { errors: n.errors.map((x) => ({ code: x.code, ...(x.description ? { description: x.description } : {}), ...(x.remedy ? { remedy: x.remedy } : {}) })) } : {}), ackedAt: null });
    fresh.push(n.type);
  }
  if (status === "rejected") {
    const ns = [...receipts].reverse().find((r) => r.type === "NS");
    lastError = ns?.errors?.length ? { code: ns.errors[0]!.code, message: (ns.errors[0]!.description ?? "Rejected by SdI").slice(0, 300) } : { code: "NS", message: "Rejected by SdI" };
  }

  // Ack once persisted (lets PASSO purge receipts after its grace period).
  const toAck = receipts.some((r) => !r.ackedAt);
  const patch: Record<string, unknown> = { status, receipts, updatedAt: ts, lastError };
  if (remote.channelRef) patch.channelRef = remote.channelRef;
  if (toAck) {
    await subs.updateOne({ id: row.id, accountId: row.accountId } as never, { $set: patch } as never);
    try {
      await client.ack(row.passoSubmissionId);
      const acked = receipts.map((r) => (r.ackedAt ? r : { ...r, ackedAt: ts }));
      patch.receipts = acked;
    } catch (e) {
      ctx.logger.warn({ submissionId: row.passoSubmissionId, ...errInfo(e) }, "einvoice ack failed (will retry next sync)");
    }
  }

  // Polling policy: in-flight fast, MC slow then stop, finals stop; hard stop at MAX_POLL_DAYS.
  const ageDays = daysBetweenIso(row.createdAt.slice(0, 10), ts.slice(0, 10));
  let interval = pollIntervalSec(status, loadConfig().PASSO_POLL_INTERVAL_SEC);
  if (status === "awaiting_delivery" && ageDays >= MC_POLL_DAYS) interval = null;
  if (ageDays >= MAX_POLL_DAYS) interval = null;
  patch.pollingDone = interval === null;
  patch.nextSyncAt = interval === null ? null : addSeconds(ts, interval);
  await subs.updateOne({ id: row.id, accountId: row.accountId } as never, { $set: patch } as never);

  if (!row.xml) await archiveXml(db, client, { ...row, status }, ctx);

  // Reflect on the document (only if this is still its current attempt).
  const docs = db.collection<DocLike>(collectionFor(row.docKind));
  const doc = (await docs.findOne({ id: row.docId, accountId: row.accountId } as never, { projection: { _id: 0, einvoice: 1 } })) as { einvoice?: { currentSubmissionId?: string | null; lastEventAt?: string | null } } | null;
  if (doc?.einvoice?.currentSubmissionId === row.id) {
    await setDocState(db, row.docKind, row.accountId, row.docId, {
      status,
      legallyIssued: isLegallyIssued(status),
      identificativoSdI: remote.identificativoSdI ?? null,
      lastEventAt: fresh.length > 0 ? ts : doc.einvoice.lastEventAt ?? ts,
      lastError,
    });
  }
  if (isFinalStatus(status) || fresh.length > 0) {
    ctx.logger.info({ accountId: row.accountId, docId: row.docId, status, receipts: fresh }, "einvoice status updated");
  }
};

const sync = async (job: Extract<EInvoiceJob, { kind: "sync" }>, ctx: ProcessorContext): Promise<unknown> => {
  const db = await getDb();
  const acct = await loadAccount(db, job.accountId);
  const subs = db.collection<EInvoiceSubmissionDoc>(SUBMISSIONS);
  if (!acct.client) return { skipped: "not_connected" };
  let rows: EInvoiceSubmissionDoc[];
  if (job.submissionId) {
    const one = await subs.findOne({ id: job.submissionId, accountId: job.accountId } as never, { projection: { _id: 0 } });
    rows = one ? [one as EInvoiceSubmissionDoc] : [];
  } else {
    rows = (await subs
      .find({ accountId: job.accountId, pollingDone: { $ne: true }, nextSyncAt: { $lte: nowIso() } } as never, { projection: { _id: 0 } })
      .limit(100)
      .toArray()) as EInvoiceSubmissionDoc[];
  }
  for (const r of rows) {
    try {
      await syncOne(db, acct, r, ctx);
    } catch (e) {
      ctx.logger.error({ err: e, submissionId: r.id }, "einvoice sync failed for a submission");
    }
  }
  return { synced: rows.length };
};

// ── tick ──────────────────────────────────────────────────────────────────────
const tick = async (_job: Extract<EInvoiceJob, { kind: "tick" }>, ctx: ProcessorContext): Promise<unknown> => {
  const db = await getDb();
  const accounts = (await db.collection(SUBMISSIONS).distinct("accountId", { pollingDone: { $ne: true }, nextSyncAt: { $lte: nowIso() } } as never)) as string[];
  for (const accountId of accounts) {
    await einvoiceQueue().add("einvoice-sync", { kind: "sync", accountId } satisfies EInvoiceJob, { jobId: `einvoice-sync-acct-${accountId}-${Math.floor(Date.now() / 60000)}` });
  }
  ctx.logger.debug({ accounts: accounts.length }, "einvoice tick");
  return { accounts: accounts.length };
};

export const einvoiceHandler = async (job: EInvoiceJob, ctx: ProcessorContext): Promise<unknown> => {
  switch (job.kind) {
    case "submit":
      return submit(job, ctx);
    case "retry":
      return retry(job, ctx);
    case "sync":
      return sync(job, ctx);
    case "tick":
      return tick(job, ctx);
  }
};
