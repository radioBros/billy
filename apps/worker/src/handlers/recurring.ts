import { randomBytes } from "node:crypto";
import { MongoClient, type Db, type Collection } from "mongodb";
import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { loadConfig } from "@billy/config";
import { advanceRecurrence, DEFAULT_PAYMENT_TERM_DAYS, resolvePlaceholders, type TemplateContext } from "@billy/shared";
import type { EmailJob, JobPayloads, PdfJob } from "@billy/types";
import type { ProcessorContext } from "@/processors.js";
import { enqueueEInvoiceSubmit } from "@/handlers/einvoice.js";

const cryptoRandomId = (): string => {
  return randomBytes(12).toString("hex");
};

// ── Lazy queue producers (email + pdf), mirroring the lazy-Mongo pattern above.
// The recurring tick is the only worker path that PRODUCES jobs; keep the
// connection self-contained so nothing is created at import time (tests).
//
// The per-job retry/retention policy MIRRORS the api's DEFAULT_JOB_OPTIONS
// (platform/queue.ts) — the worker cannot import the api package, so it is
// replicated here. `attempts: 5` matters: the email handler THROWS when an
// attachment PDF is not yet scan-clean, relying on BullMQ retries; with the
// BullMQ default of `attempts: 1` a single throw would be terminal.
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};
let cachedRedis: Redis | null = null;
let cachedEmailQueue: Queue | null = null;
let cachedPdfQueue: Queue | null = null;
const redisConn = (): Redis => {
  if (!cachedRedis) {
    const cfg = loadConfig();
    cachedRedis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
  }
  return cachedRedis;
};
const emailQueue = (): Queue => {
  if (!cachedEmailQueue) cachedEmailQueue = new Queue("email", { connection: redisConn(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
  return cachedEmailQueue;
};
const pdfQueue = (): Queue => {
  if (!cachedPdfQueue) cachedPdfQueue = new Queue("pdf", { connection: redisConn(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
  return cachedPdfQueue;
};

/**
 * Recurring/scheduled tick.
 *
 * This is the FIRST worker→invoice-write path. It runs on the repeatable
 * `recurring` job and, under a SYSTEM context, does two scans:
 *   1. Scheduled-send: finalize `scheduled` invoices whose `scheduledSendDate`
 *      has arrived — assign the number NOW (never at schedule time, so numbering
 *      stays ordered by issue date; tax-compliance) + snapshot the client +
 *      flip to `finalized`. (Email-on-send rides the existing email queue; a
 *      missing SMTP config must NEVER block finalize.)
 *   2. Recurring: for `active` profiles due (`nextRunAt <= today`), create the
 *      occurrence invoice (as a finalized doc) + advance the schedule.
 *
 * Self-contained (lazy-cached MongoClient, like email.ts) — the worker cannot
 * import the api service, so it replicates finalize's numbering + snapshot
 * exactly against Mongo. Idempotent: each op is a version/status-guarded update,
 * so a re-tick can't double-finalize or double-generate.
 */

// ── Lazy Mongo (mirrors handlers/email.ts) ────────────────────────────────────
let cachedClient: MongoClient | null = null;
const getDb = async (): Promise<Db> => {
  const cfg = loadConfig();
  if (!cachedClient) {
    cachedClient = new MongoClient(cfg.MONGO_URI, { serverSelectionTimeoutMS: 2000 });
    await cachedClient.connect();
  }
  return cachedClient.db();
};

/** `YYYY-MM-DD` for "now" in an IANA timezone (falls back to UTC on a bad zone). */
export const todayIn = (timeZone: string | null | undefined, now: Date = new Date()): string => {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
};

/** The latest "today" anywhere on earth (UTC+14) — a superset bound for the
 *  due-scans; each candidate is then re-checked against ITS account's timezone. */
const latestTodayIso = (): string => todayIn("Pacific/Kiritimati");

/** Whole days between two DateOnly strings (b - a). */
const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const addDays = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Per-tick cache of each account's business timezone (default Europe/Rome). */
const makeTimezoneResolver = (db: Db): ((accountId: string | undefined) => Promise<string>) => {
  const cache = new Map<string, string>();
  return async (accountId) => {
    const key = accountId ?? "";
    const hit = cache.get(key);
    if (hit) return hit;
    let tz = "Europe/Rome";
    try {
      const doc = (await db
        .collection("settings")
        .findOne({ key: "business", ...(accountId ? { accountId } : {}) } as never, { projection: { _id: 0, "data.timezone": 1 } })) as
        | { data?: { timezone?: string | null } }
        | null;
      if (doc?.data?.timezone) tz = doc.data.timezone;
    } catch {
      /* default */
    }
    cache.set(key, tz);
    return tz;
  };
};

// ── Numbering (replicates platform/numbering.ts EXACTLY — gap-free, atomic) ────
interface Counter {
  _id: string;
  seq: number;
}

interface ClientDoc {
  id: string;
  type?: string | null;
  displayName: string;
  legalName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  billingAddress?: unknown;
  vatNumber?: string | null;
  taxCode?: string | null;
  recipientCode?: string | null;
  pecEmail?: string | null;
  country?: string | null;
  preferredLanguage?: string | null;
  referral?: string | null;
}

/**
 * Immutable client snapshot — MIRRORS the api's finalize snapshot
 * (invoices/service.ts) field-for-field, so a worker-finalized invoice carries
 * the same fiscal identity (SDI code, PEC, CF, …) the e-invoice mapper needs.
 */
export const buildClientSnapshot = (client: ClientDoc, currency: string): Record<string, unknown> => ({
  clientId: client.id,
  type: client.type ?? null,
  displayName: client.displayName,
  legalName: client.legalName ?? null,
  firstName: client.firstName ?? null,
  lastName: client.lastName ?? null,
  email: client.email ?? null,
  billingAddress: client.billingAddress ?? null,
  vatNumber: client.vatNumber ?? null,
  taxCode: client.taxCode ?? null,
  recipientCode: client.recipientCode ?? null,
  pecEmail: client.pecEmail ?? null,
  country: client.country ?? null,
  currency,
  preferredLanguage: client.preferredLanguage ?? null,
  referral: client.referral ?? null,
});

interface InvoiceDoc {
  id: string;
  version: number;
  accountId: string;
  clientId: string;
  currency: string;
  issueDate: string;
  dueDate?: string | null;
  status: string;
  scheduledSendDate?: string | null;
  invoiceNumber?: string | null;
  /** E-invoicing: send to SdI as soon as the scheduled invoice is finalized. */
  einvoice?: { submitOnFinalize?: boolean } | null;
}

const nowTs = (): string => new Date().toISOString();

const finalizeScheduled = async (db: Db, inv: InvoiceDoc, issueDate: string, ctx: ProcessorContext): Promise<string | null> => {
  const clients = db.collection<ClientDoc>("clients");
  const invoices = db.collection<InvoiceDoc>("invoices");
  const counters = db.collection<Counter>("counters");

  // Account-scoped lookup — never resolve another account's client.
  const client = await clients.findOne({ id: inv.clientId, accountId: inv.accountId, deletedAt: null } as never, { projection: { _id: 0 } });
  const snapshot = client ? buildClientSnapshot(client, inv.currency) : null;

  // The invoice is ISSUED today (account timezone), not on the date it was drafted:
  // FatturaPA `Data` and the number's year must be the real issue date. The
  // payment term (issue→due gap) is preserved.
  const termDays = inv.dueDate ? Math.max(0, daysBetween(inv.issueDate, inv.dueDate)) : 0;
  const dueDate = addDays(issueDate, termDays);
  const year = Number(issueDate.slice(0, 4));
  // Per-account series — the SAME counter the api's finalize uses
  // (`${accountId}:invoice-${year}`), so scheduled + manual invoices share one
  // gap-free, non-colliding sequence per account.
  const invoiceNumber = await nextDocNumber(counters, inv.accountId, `invoice-${year}`, "INV", year, true);

  // Guard on the CURRENT version + still-scheduled status → exactly-once.
  const res = await invoices.findOneAndUpdate(
    { id: inv.id, version: inv.version, status: "scheduled" } as never,
    {
      $set: {
        status: "finalized",
        invoiceNumber,
        issueDate,
        dueDate,
        scheduledSendDate: null,
        ...(snapshot ? { clientSnapshot: snapshot } : {}),
        updatedAt: nowTs(),
      },
      $inc: { version: 1 },
    } as never,
    { returnDocument: "after", projection: { _id: 0 } },
  );
  if (!res) {
    // Lost the race (another tick finalized it) — the number we minted is a gap.
    // Acceptable: gap-free is best-effort under concurrency; correctness (no dup)
    // is preserved. Log so it's visible.
    ctx.logger.warn({ invoiceId: inv.id }, "scheduled invoice already finalized by another tick");
    return null;
  }
  ctx.logger.info({ invoiceId: inv.id, invoiceNumber }, "scheduled invoice finalized on send date");
  return invoiceNumber;
};

// ── Recurring-profile auto-generate ───────────────────────────────────────────
// Date advancement uses the SINGLE shared source of truth (@billy/shared), the
// same function the api service calls — no more hand-synced duplicate. The
// optional `dayOfMonth` anchor ("every Nth of month", drift-free) is honored.
type RInterval = "weekly" | "monthly" | "quarterly" | "yearly";
const advanceDate = (iso: string, interval: RInterval, count: number, dayOfMonth?: number | null): string =>
  advanceRecurrence(iso, interval, count, dayOfMonth);

interface LineComputed {
  lineTotalMinor?: number;
  lineSubtotalMinor?: number;
  lineDiscountMinor?: number;
  lineTaxMinor?: number;
}
interface ProfileDoc {
  id: string;
  version: number;
  /** Owning account — occurrences MUST inherit this so they are account-scoped. */
  accountId: string;
  clientId: string;
  currency: string;
  /** invoice | proforma | expense — which doc each occurrence generates. */
  documentType?: "invoice" | "proforma" | "expense";
  interval: RInterval;
  intervalCount: number;
  /** Optional day-of-month anchor (1–31) for monthly-family cadences. */
  dayOfMonth?: number | null;
  nextRunAt: string;
  endDate?: string | null;
  maxOccurrences?: number | null;
  occurrencesGenerated: number;
  status: string;
  subject?: string | null;
  notes?: string | null;
  lineItems: LineComputed[];
  /** Days from issue to due (absent ⇒ DEFAULT_PAYMENT_TERM_DAYS). For a
   *  proforma it is the issue→expiry gap (a proforma has no due date). */
  paymentTermDays?: number | null;
  /** Business-settings bank account id, resolved to a `bankSnapshot` at generation. */
  bankAccountId?: string | null;
  /** Optional project copied onto each generated document. */
  projectId?: string | null;
  /** Expense-only template fields (expense profiles). */
  expense?: { category?: string | null; vendor?: string | null; description?: string | null; billable?: boolean | null } | null;
  autoSend?: RecurringAutoSend | null;
  /** E-invoicing: send each generated invoice to SdI. */
  einvoice?: { autoSubmit?: boolean } | null;
}

/** Auto-send config stored on the profile (mirrors api recurring-billing/types.ts). */
interface RecurringAutoSend {
  enabled: boolean;
  to?: string | null;
  cc?: string[];
  bcc?: string[];
  subject?: string | null;
  body?: string | null;
  requestReadReceipt?: boolean;
  /** BCC the company's own email (business settings) on every occurrence's email. */
  copyToCompany?: boolean;
  /** Extra static file ids attached to every occurrence's email. */
  attachmentFileIds?: string[];
}

/** Per-doc-type numbering series + collection + prefix (mirrors each module). */
const DOC_CONFIG = {
  // `slashYear` docs number as `{seq}/{year}` (e.g. 20/2026), matching the api;
  // expenses keep the prefixed EXP-YEAR-#### form.
  invoice: { collection: "invoices", series: (y: number) => `invoice-${y}`, prefix: "INV", slashYear: true },
  proforma: { collection: "proformas", series: (y: number) => `proforma-${y}`, prefix: "PRO", slashYear: true },
  expense: { collection: "expenses", series: (y: number) => `expense-${y}`, prefix: "EXP", slashYear: false },
} as const;

const nextDocNumber = async (
  counters: Collection<Counter>,
  accountId: string,
  series: string,
  prefix: string,
  year: number,
  slashYear: boolean,
): Promise<string> => {
  // Per-account series key + accountId stamp — mirrors platform/numbering.ts so
  // each account has its own gap-free sequence and account-delete can purge it.
  const r = await counters.findOneAndUpdate(
    { _id: `${accountId}:${series}` },
    { $inc: { seq: 1 }, $setOnInsert: { accountId } },
    { upsert: true, returnDocument: "after" },
  );
  const seq = r?.seq ?? 1;
  return slashYear ? `${seq}/${year}` : `${prefix}-${year}-${String(seq).padStart(4, "0")}`;
};

/** A business-settings bank account (mirrors api settings `BankAccount`). */
interface BankAccountRecord {
  id: string;
  label: string;
  details: string;
  iban?: string | null;
}

/**
 * Resolve the profile's bank account into the immutable `bankSnapshot` the PDF
 * (and, for invoices, e-invoicing via `bankSnapshot.iban`) reads. MIRRORS the api
 * invoice create (invoices/service.ts resolveBankSnapshot): a stored id → that
 * account (null if it no longer exists); no id + exactly one account → that one;
 * otherwise null. Proformas carry `{ label, details }` only (their type has no iban).
 */
export const resolveBankSnapshot = (
  accounts: BankAccountRecord[],
  bankAccountId: string | null | undefined,
  docType: "invoice" | "proforma",
): Record<string, unknown> | null => {
  let chosen: BankAccountRecord | undefined;
  if (bankAccountId != null) chosen = accounts.find((a) => a.id === bankAccountId);
  else if (accounts.length === 1) chosen = accounts[0];
  if (!chosen) return null;
  if (docType === "proforma") return { label: chosen.label, details: chosen.details };
  return { label: chosen.label, details: chosen.details, ...(chosen.iban ? { iban: chosen.iban } : {}) };
};

const loadBankAccounts = async (db: Db, accountId: string): Promise<BankAccountRecord[]> => {
  const doc = (await db
    .collection("settings")
    .findOne({ key: "business", accountId } as never, { projection: { _id: 0, "data.bankAccounts": 1 } })) as
    | { data?: { bankAccounts?: BankAccountRecord[] } }
    | null;
  return doc?.data?.bankAccounts ?? [];
};

/** True when the profile may not generate another occurrence (count reached or
 *  the occurrence date is past endDate). Same rule as the api `isExhausted`. */
const isExhausted = (p: Pick<ProfileDoc, "maxOccurrences" | "occurrencesGenerated" | "endDate">, date: string): boolean =>
  (p.maxOccurrences != null && p.occurrencesGenerated >= p.maxOccurrences) || (p.endDate != null && date > p.endDate);

/**
 * Generate ONE occurrence from a due profile. `today` is the account's
 * business-timezone date. Order matters:
 *   1. pre-check exhaustion → mark completed (version-guarded), no document;
 *   2. client must still exist (deleted → skip + warn; the api refuses finalize
 *      without a client too) — checked BEFORE the advance so the occurrence is
 *      not consumed;
 *   3. advance the profile (version-guarded, exactly-once);
 *   4. ONLY THEN allocate the number (a lost race mints no gap);
 *   5. write the document.
 * A backdated occurrence (date before today) is ISSUED TODAY — like scheduled
 * finalize — so numbering stays chronological; the term counts from today.
 */
const generateFromProfile = async (
  db: Db,
  p: ProfileDoc,
  ctx: ProcessorContext,
  today: string,
  /** "Generate now": always issue today — a future occurrence date with a
   *  number minted today would break chronological numbering. */
  issueToday = false,
): Promise<string | null> => {
  const docType = p.documentType ?? "invoice";
  const cfg = DOC_CONFIG[docType];
  const profiles = db.collection<ProfileDoc>("recurringProfiles");
  const clients = db.collection<ClientDoc>("clients");
  const counters = db.collection<Counter>("counters");
  const target = db.collection<Record<string, unknown>>(cfg.collection);
  const occurrenceDate = p.nextRunAt;

  // 1. Already exhausted (e.g. maxOccurrences lowered / endDate moved before
  //    nextRunAt) → complete without generating.
  if (isExhausted(p, occurrenceDate)) {
    const done = await profiles.findOneAndUpdate(
      { id: p.id, version: p.version, status: "active" } as never,
      { $set: { status: "completed", updatedAt: nowTs() }, $inc: { version: 1 } } as never,
      { returnDocument: "after" },
    );
    ctx.logger.info({ profileId: p.id, completed: !!done }, "recurring profile exhausted — completed without generating");
    return null;
  }

  // 2. Account-scoped client lookup; a deleted client blocks generation.
  const client = await clients.findOne({ id: p.clientId, accountId: p.accountId, deletedAt: null } as never, { projection: { _id: 0 } });
  if (!client) {
    ctx.logger.warn({ profileId: p.id, clientId: p.clientId }, "recurring: client not found (deleted?) — skipping occurrence");
    return null;
  }

  // Sum the pre-computed line money into document totals (no re-derivation).
  const subtotal = p.lineItems.reduce((s, l) => s + (l.lineSubtotalMinor ?? 0), 0);
  const discount = p.lineItems.reduce((s, l) => s + (l.lineDiscountMinor ?? 0), 0);
  const tax = p.lineItems.reduce((s, l) => s + (l.lineTaxMinor ?? 0), 0);
  const grand = p.lineItems.reduce((s, l) => s + (l.lineTotalMinor ?? 0), 0);

  // Backdated catch-up → issue today (chronological numbering, real issue date).
  const issueDate = issueToday || occurrenceDate < today ? today : occurrenceDate;
  const now = nowTs();
  const docId = cryptoRandomId();

  // 3. Advance/exhaust the profile FIRST, version-guarded → exactly-once. If
  //    another tick already advanced it, skip BEFORE minting a number.
  const nextRun = advanceDate(occurrenceDate, p.interval, p.intervalCount, p.dayOfMonth);
  const generated = p.occurrencesGenerated + 1;
  const exhausted = isExhausted({ ...p, occurrencesGenerated: generated }, nextRun);
  const advance = await profiles.findOneAndUpdate(
    { id: p.id, version: p.version, status: "active" } as never,
    {
      $set: {
        nextRunAt: nextRun,
        occurrencesGenerated: generated,
        lastRunAt: now,
        ...(exhausted ? { status: "completed" } : {}),
        updatedAt: now,
      },
      $inc: { version: 1 },
    } as never,
    { returnDocument: "after" },
  );
  if (!advance) {
    ctx.logger.warn({ profileId: p.id }, "recurring profile advanced by another tick — skipping");
    return null;
  }

  // 4. Number in the ISSUE year, only now that this run owns the occurrence.
  const year = Number(issueDate.slice(0, 4));
  const docNumber = await nextDocNumber(counters, p.accountId, cfg.series(year), cfg.prefix, year, cfg.slashYear);

  const common = {
    id: docId,
    version: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    accountId: p.accountId,
    clientId: p.clientId,
    projectId: p.projectId ?? null,
    currency: p.currency,
    sourceRecurringProfileId: p.id,
  };

  let doc: Record<string, unknown>;
  if (docType === "expense") {
    // Expense shape (api expenses/types.ts): a single amount, no line items,
    // client snapshot or invoice totals; status `draft` (not yet invoiced).
    const firstLine = (p.lineItems[0] as { description?: string } | undefined)?.description?.trim() || "";
    const e = p.expense ?? {};
    doc = {
      ...common,
      expenseNumber: docNumber,
      amountMinor: grand,
      date: issueDate,
      category: e.category?.trim() || "recurring",
      vendor: e.vendor?.trim() || firstLine || client.displayName,
      description: e.description?.trim() ?? p.notes?.trim() ?? firstLine,
      billable: e.billable === true,
      status: "draft",
      invoicedAt: null,
      invoiceId: null,
    };
  } else {
    const bankSnapshot = resolveBankSnapshot(await loadBankAccounts(db, p.accountId), p.bankAccountId, docType);
    // Issue + the profile's term (default 7 days, like the invoice form).
    const termEnd = addDays(issueDate, p.paymentTermDays ?? DEFAULT_PAYMENT_TERM_DAYS);
    // Auto-send: when the profile has it enabled, mark the occurrence pending so a
    // later tick (Scan 3) emails it once its PDF is clean, and kick off the render
    // now. Only invoice/proforma reach here (expense is schema-blocked from autoSend).
    const autoSendPending = p.autoSend?.enabled === true;
    const shared = {
      ...common,
      clientSnapshot: buildClientSnapshot(client, p.currency),
      bankSnapshot,
      issueDate,
      subject: p.subject ?? null,
      notes: p.notes ?? null,
      lineItems: p.lineItems,
      subtotalMinor: subtotal,
      discountMinor: discount,
      taxMinor: tax,
      grandTotalMinor: grand,
      ...(autoSendPending ? { autoSendPending: true, autoSendAt: null } : {}),
    };
    doc =
      docType === "invoice"
        ? {
            ...shared,
            invoiceNumber: docNumber,
            status: "finalized",
            dueDate: termEnd,
            amountPaidMinor: 0,
            amountDueMinor: grand,
            payments: [],
            // E-invoicing flag; the submit job (enqueued below) re-checks that the integration is on.
            ...(p.einvoice?.autoSubmit ? { einvoice: { status: "not_sent", legallyIssued: false, submitOnFinalize: true } } : {}),
          }
        : {
            // Proforma shape (api proforma/types.ts): NON-FISCAL — expiry instead
            // of a due date, no payment/balance fields.
            ...shared,
            proformaNumber: docNumber,
            status: "issued",
            expiryDate: termEnd,
            convertedInvoiceId: null,
          };
  }
  await target.insertOne(doc as never);
  // Record the generated document on the profile (feeds the detail page's
  // "generated documents" list). Best-effort — never blocks generation.
  try {
    await profiles.updateOne({ id: p.id } as never, { $push: { createdInvoiceIds: docId }, $set: { updatedAt: now } } as never);
  } catch {
    /* non-fatal */
  }
  ctx.logger.info({ profileId: p.id, documentType: docType, docId, docNumber, occurrenceDate, issueDate, exhausted }, "recurring occurrence generated");

  if (docType === "invoice" && p.einvoice?.autoSubmit) {
    try {
      await enqueueEInvoiceSubmit(p.accountId, "invoice", docId, "recurring");
    } catch (err) {
      ctx.logger.warn({ err, docId }, "einvoice enqueue failed for recurring occurrence (send manually)");
    }
  }

  // Kick off the PDF render for an auto-send occurrence so it is ready to email
  // on a following tick. Best-effort: a failure here just means Scan 3 finds no
  // clean PDF and re-enqueues. Never blocks generation.
  if (docType !== "expense" && p.autoSend?.enabled === true) {
    try {
      await pdfQueue().add(
        "pdf",
        { documentType: docType, documentId: docId, accountId: p.accountId } satisfies PdfJob,
        // BullMQ rejects ":" in custom job ids — use "-" separators.
        { jobId: `pdf-${docType}-${docId}` },
      );
    } catch (err) {
      ctx.logger.warn({ err, docId }, "auto-send: PDF enqueue failed (Scan 3 will retry)");
    }
  }
  return docNumber;
};

// ── Scan 3 — auto-send generated occurrences ─────────────────────────────────
// An occurrence stamped `autoSendPending` (invoice/proforma from an autoSend-ON
// profile) is emailed once its PDF is scan-clean. The profile's subject/body may
// contain `{{...}}` tokens, resolved PER-OCCURRENCE here against the occurrence's
// own dates/number/client + company branding (mirrors the api send path). The
// terminal step reuses the existing `email` queue (worker enqueues directly).

interface OccurrenceDoc {
  id: string;
  version: number;
  accountId: string;
  currency: string;
  issueDate: string;
  dueDate?: string | null;
  /** Proformas carry an expiry instead of a due date. */
  expiryDate?: string | null;
  invoiceNumber?: string | null;
  proformaNumber?: string | null;
  grandTotalMinor?: number;
  sourceRecurringProfileId?: string | null;
  clientSnapshot?: { displayName?: string | null; email?: string | null; vatNumber?: string | null; billingAddress?: unknown } | null;
  autoSendPending?: boolean;
}
interface PdfFileDoc {
  id: string;
  filename?: string | null;
  scanStatus?: string | null;
}
interface BrandingSettings {
  businessName?: string | null;
  email?: string | null;
  vatNumber?: string | null;
  address?: { line1?: string | null; line2?: string | null; postalCode?: string | null; city?: string | null; region?: string | null; country?: string | null } | null;
}

/** Minimal currency-minor → display string (self-contained; the total feeds a
 *  `{{total}}` token only, so exact locale grouping is not critical). */
const displayMoney = (minor: number | undefined, currency: string): string => {
  const v = (minor ?? 0) / 100;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(v);
  } catch {
    return `${v.toFixed(2)} ${currency}`;
  }
};

/** Read the business settings singleton for a company-tier placeholder context. */
const readBusiness = async (db: Db, accountId: string): Promise<BrandingSettings> => {
  const doc = (await db
    .collection<{ key: string; accountId: string; data?: BrandingSettings }>("settings")
    .findOne({ key: "business", accountId } as never, { projection: { _id: 0 } })) as { data?: BrandingSettings } | null;
  return doc?.data ?? {};
};

/** Build the placeholder context for an occurrence's auto-send email. Mirrors the
 *  api `buildSendTemplateContext` — same tokens resolve identically. */
const occurrenceContext = (occ: OccurrenceDoc, biz: BrandingSettings): TemplateContext => {
  const a = (occ.clientSnapshot?.billingAddress ?? null) as BrandingSettings["address"];
  const companyAddr = biz.address;
  return {
    now: occ.issueDate,
    issueDate: occ.issueDate,
    dueDate: occ.dueDate ?? null,
    // A proforma has no due date; its validity resolves {{expiryDate}}.
    expiryDate: occ.expiryDate ?? null,
    document: { number: occ.invoiceNumber ?? occ.proformaNumber ?? null, total: displayMoney(occ.grandTotalMinor, occ.currency) },
    client: {
      name: occ.clientSnapshot?.displayName ?? null,
      email: occ.clientSnapshot?.email ?? null,
      vat: occ.clientSnapshot?.vatNumber ?? null,
      address: a ? { line1: a.line1 ?? null, line2: a.line2 ?? null, postalCode: a.postalCode ?? null, city: a.city ?? null, region: a.region ?? null, country: a.country ?? null } : null,
    },
    company: {
      name: biz.businessName ?? null,
      email: biz.email ?? null,
      vat: biz.vatNumber ?? null,
      address: companyAddr ? { line1: companyAddr.line1 ?? null, line2: companyAddr.line2 ?? null, postalCode: companyAddr.postalCode ?? null, city: companyAddr.city ?? null, region: companyAddr.region ?? null, country: companyAddr.country ?? null } : null,
    },
  };
};

/**
 * Resolve the profile's extra attachment file ids to send-ready refs, keeping ONLY
 * those that are account-owned, not deleted, and scan-clean. A missing / not-clean
 * extra is silently dropped (logged) so it never blocks the occurrence's own PDF —
 * this is the deliberate divergence from the api's resolveExtraAttachments, which
 * throws. Order is preserved. Empty/absent list → [].
 */
const resolveCleanExtras = async (
  db: Db,
  accountId: string,
  fileIds: string[] | undefined,
  ctx: ProcessorContext,
): Promise<{ fileId: string; filename: string }[]> => {
  const ids = (fileIds ?? []).filter((s) => typeof s === "string" && s.length > 0);
  if (ids.length === 0) return [];
  const rows = (await db
    .collection("files")
    .find({ id: { $in: ids }, accountId, deletedAt: null } as never, { projection: { _id: 0, id: 1, filename: 1, scanStatus: 1 } })
    .toArray()) as unknown as { id: string; filename?: string | null; scanStatus?: string | null }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: { fileId: string; filename: string }[] = [];
  for (const id of ids) {
    const f = byId.get(id);
    if (!f || f.scanStatus !== "clean") {
      ctx.logger.warn({ fileId: id, status: f?.scanStatus ?? "not-found" }, "auto-send: dropping unavailable extra attachment (invoice still sent)");
      continue;
    }
    out.push({ fileId: id, filename: f.filename || "attachment" });
  }
  return out;
};

/** Latest clean PDF for a rendered occurrence (mirrors send-document.findCleanPdf). */
const findCleanOccurrencePdf = async (db: Db, ownerType: "invoice" | "proforma", ownerId: string): Promise<PdfFileDoc | null> => {
  const rows = (await db
    .collection("files")
    .find({ ownerType, ownerId, contentType: "application/pdf", deletedAt: null } as never, { projection: { _id: 0 } })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray()) as unknown as PdfFileDoc[];
  const f = rows[0];
  return f && f.scanStatus === "clean" ? f : null;
};

/** Send one pending occurrence for a given doc type. Returns true if emailed. */
const sendPendingOccurrence = async (
  db: Db,
  ownerType: "invoice" | "proforma",
  occ: OccurrenceDoc,
  profile: ProfileDoc,
  ctx: ProcessorContext,
): Promise<boolean> => {
  const as = profile.autoSend;
  if (!as || as.enabled !== true) return false;
  const to = (as.to ?? occ.clientSnapshot?.email ?? "").trim();
  if (!to) {
    ctx.logger.warn({ docId: occ.id }, "auto-send: no recipient — skipping (config requires `to`)");
    return false;
  }
  const clean = await findCleanOccurrencePdf(db, ownerType, occ.id);
  if (!clean) {
    // PDF not ready yet — re-enqueue the render and leave pending for the next tick.
    try {
      await pdfQueue().add("pdf", { documentType: ownerType, documentId: occ.id, accountId: occ.accountId } satisfies PdfJob, { jobId: `pdf-${ownerType}-${occ.id}` });
    } catch {
      /* best-effort */
    }
    return false;
  }

  // Resolve placeholders PER-OCCURRENCE against this occurrence's own context.
  const biz = await readBusiness(db, occ.accountId);
  const tctx = occurrenceContext(occ, biz);
  const subject = resolvePlaceholders(as.subject ?? "", tctx);
  const html = resolvePlaceholders(as.body ?? "", tctx);

  // Extra static attachments configured on the profile. Unlike the api send path
  // (which THROWS on a missing/not-clean extra), auto-send DROPS a bad extra and
  // still sends — a deleted cover-letter must never block the invoice itself. Only
  // scan-clean, non-deleted, account-owned files are attached.
  const extras = await resolveCleanExtras(db, occ.accountId, as.attachmentFileIds, ctx);

  // "Copy to company" → BCC the business's own email. Unlike the api send path
  // (which throws), a missing company email is only logged — auto-send must never
  // block the occurrence's own delivery.
  let bcc = as.bcc ?? [];
  if (as.copyToCompany) {
    const company = (biz.email ?? "").trim();
    if (!company) {
      ctx.logger.warn({ docId: occ.id }, "auto-send: copyToCompany set but no company email in business settings — skipping copy");
    } else if (company !== to && !bcc.includes(company)) {
      bcc = [...bcc, company];
    }
  }

  const payload: EmailJob = {
    to,
    // Mirrors EMAIL_TEMPLATES.genericNotification (api email/types.ts) — the worker
    // cannot import the api package. The email handler reads data.subject/html/text
    // for a message override, so `template` is routing metadata only.
    template: "generic-notification",
    accountId: occ.accountId,
    ...(as.cc && as.cc.length > 0 ? { cc: as.cc } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    ...(as.requestReadReceipt ? { requestReadReceipt: true } : {}),
    attachments: [
      { fileId: clean.id, filename: clean.filename || `${tctx.document?.number ?? occ.id}.pdf` },
      ...extras,
    ],
    data: { subject, html, text: html },
  };

  // ENQUEUE FIRST, then claim. Deliberate ordering: a failed enqueue (Redis blip)
  // must leave the occurrence pending so a later tick retries — the reverse order
  // (claim then enqueue) would PERMANENTLY drop the email on a transient failure.
  // The deterministic jobId is BullMQ's dedup key, so a re-tick after a *successful*
  // enqueue whose claim then failed cannot create a second job while the first is
  // still queued. Worst case is a rare duplicate (job already completed + evicted),
  // which for invoice delivery is preferable to a silent miss.
  await emailQueue().add("email", payload, { jobId: `autosend-${ownerType}-${occ.id}`, ...DEFAULT_JOB_OPTIONS });

  // Mark sent (version-guarded) so the scan won't re-enqueue on the next tick.
  const collection = db.collection<OccurrenceDoc>(ownerType === "invoice" ? "invoices" : "proformas");
  const claimed = await collection.findOneAndUpdate(
    { id: occ.id, version: occ.version, autoSendPending: true } as never,
    { $set: { autoSendPending: false, autoSendAt: nowTs(), updatedAt: nowTs() }, $inc: { version: 1 } } as never,
    { returnDocument: "after" },
  );
  if (!claimed) {
    // Enqueue succeeded but the mark-sent lost a race / failed. The deterministic
    // jobId prevents a duplicate while the job is still live; log for visibility.
    ctx.logger.warn({ docId: occ.id }, "auto-send: email enqueued but mark-sent did not apply (jobId dedup guards duplicates)");
  }
  ctx.logger.info({ docId: occ.id, ownerType, to }, "auto-send: occurrence email enqueued");
  return true;
};

/** Scan for pending auto-send occurrences (invoice + proforma) and send the ready ones. */
const autoSendScan = async (db: Db, ctx: ProcessorContext): Promise<number> => {
  const profiles = db.collection<ProfileDoc>("recurringProfiles");
  let sent = 0;
  for (const ownerType of ["invoice", "proforma"] as const) {
    const collection = db.collection<OccurrenceDoc>(ownerType === "invoice" ? "invoices" : "proformas");
    const pending = (await collection
      .find({ autoSendPending: true, deletedAt: null } as never, { projection: { _id: 0 } })
      .limit(200)
      .toArray()) as OccurrenceDoc[];
    for (const occ of pending) {
      try {
        if (!occ.sourceRecurringProfileId) continue;
        const profile = (await profiles.findOne({ id: occ.sourceRecurringProfileId } as never, { projection: { _id: 0 } })) as ProfileDoc | null;
        // Auto-send turned OFF (or profile gone) AFTER this occurrence was stamped:
        // clear the stale pending flag so it is never emailed and the scan stops
        // re-reading it every tick. (The user can toggle auto-send off at any time.)
        if (!profile || profile.autoSend?.enabled !== true) {
          await collection.updateOne(
            { id: occ.id, autoSendPending: true } as never,
            { $set: { autoSendPending: false, autoSendAt: null, updatedAt: nowTs() } } as never,
          );
          continue;
        }
        if (await sendPendingOccurrence(db, ownerType, occ, profile, ctx)) sent++;
      } catch (err) {
        ctx.logger.error({ err, docId: occ.id }, "auto-send failed (will retry next tick)");
      }
    }
  }
  return sent;
};

export const recurringTickHandler = async (payload: JobPayloads["recurring"], ctx: ProcessorContext): Promise<{ finalized: number; generated: number; autoSent: number }> => {
  const db = await getDb();
  const tzOf = makeTimezoneResolver(db);

  // Run-now ("Generate now" in the UI): generate this profile's NEXT occurrence
  // immediately through the same generator as the schedule (numbering, payment
  // term, auto-send, SdI). Matching on nextRunAt makes a replayed job a no-op —
  // generateFromProfile advances nextRunAt, so a second run finds nothing.
  let generatedNow = 0;
  if (payload?.generateNow && payload.recurringProfileId) {
    try {
      const p = (await db.collection<ProfileDoc>("recurringProfiles").findOne(
        {
          id: payload.recurringProfileId,
          accountId: payload.accountId,
          status: "active",
          nextRunAt: payload.scheduledOccurrenceDate,
          deletedAt: null,
        } as never,
        { projection: { _id: 0 } },
      )) as ProfileDoc | null;
      if (p && (await generateFromProfile(db, p, ctx, todayIn(await tzOf(p.accountId)), true))) generatedNow++;
    } catch (err) {
      ctx.logger.error({ err, profileId: payload.recurringProfileId }, "recurring generate-now failed");
    }
  }

  const invoices = db.collection<InvoiceDoc>("invoices");
  // Dates are evaluated in EACH ACCOUNT's business timezone (an invoice due "today"
  // in Rome must not wait for UTC midnight, nor fire early). Query with the latest
  // possible "today" on earth, then re-check per account.
  const today = latestTodayIso();

  // Scan 1 — scheduled-send: scheduled invoices whose date has arrived.
  const due = (await invoices
    .find({ status: "scheduled", scheduledSendDate: { $lte: today }, deletedAt: null } as never, {
      projection: { _id: 0, id: 1, version: 1, accountId: 1, clientId: 1, currency: 1, issueDate: 1, dueDate: 1, status: 1, scheduledSendDate: 1, invoiceNumber: 1, einvoice: 1 },
    })
    .toArray()) as InvoiceDoc[];

  let finalized = 0;
  for (const inv of due) {
    try {
      const accountToday = todayIn(await tzOf(inv.accountId));
      if (!inv.scheduledSendDate || inv.scheduledSendDate > accountToday) continue;
      const num = await finalizeScheduled(db, inv, accountToday, ctx);
      if (num) {
        finalized++;
        // E-invoicing: the worker finalizes directly in Mongo (no API event), so it enqueues
        // the SdI submission itself. The handler re-checks enablement + readiness.
        if (inv.einvoice?.submitOnFinalize) {
          try {
            await enqueueEInvoiceSubmit(inv.accountId, "invoice", inv.id, "scheduled");
          } catch (err) {
            ctx.logger.warn({ err, invoiceId: inv.id }, "einvoice enqueue failed for scheduled invoice (send manually)");
          }
        }
      }
    } catch (err) {
      ctx.logger.error({ err, invoiceId: inv.id }, "scheduled finalize failed (will retry next tick)");
    }
  }

  // Scan 2 — recurring auto-generate: active profiles due to run.
  const profiles = db.collection<ProfileDoc>("recurringProfiles");
  const dueProfiles = (await profiles
    .find({ status: "active", nextRunAt: { $lte: today }, deletedAt: null } as never, { projection: { _id: 0 } })
    .toArray()) as ProfileDoc[];

  let generated = 0;
  for (const p of dueProfiles) {
    try {
      const accountToday = todayIn(await tzOf(p.accountId));
      if (p.nextRunAt > accountToday) continue;
      const num = await generateFromProfile(db, p, ctx, accountToday);
      if (num) generated++;
    } catch (err) {
      ctx.logger.error({ err, profileId: p.id }, "recurring generate failed (will retry next tick)");
    }
  }

  // Scan 3 — auto-send: email generated occurrences whose PDF is now ready.
  let autoSent = 0;
  try {
    autoSent = await autoSendScan(db, ctx);
  } catch (err) {
    ctx.logger.error({ err }, "auto-send scan failed (will retry next tick)");
  }

  ctx.logger.info({ dueScheduled: due.length, finalized, dueProfiles: dueProfiles.length, generated, autoSent, today }, "recurring tick complete");
  return { finalized, generated: generated + generatedNow, autoSent };
};
