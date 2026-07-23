import { randomBytes } from "node:crypto";
import { MongoClient, type Db, type Collection } from "mongodb";
import { loadConfig } from "@billy/config";
import { advanceRecurrence } from "@billy/shared";
import type { JobPayloads } from "@billy/types";
import type { ProcessorContext } from "@/processors.js";

const cryptoRandomId = (): string => {
  return randomBytes(12).toString("hex");
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

const todayIso = (): string => {
  return new Date().toISOString().slice(0, 10);
};

// ── Numbering (replicates platform/numbering.ts EXACTLY — gap-free, atomic) ────
interface Counter {
  _id: string;
  seq: number;
}
const nextInvoiceNumber = async (counters: Collection<Counter>, year: number): Promise<string> => {
  const r = await counters.findOneAndUpdate(
    { _id: `invoice-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  const seq = r?.seq ?? 1;
  // `{seq}/{year}` (e.g. 20/2026) — matches the api's slashYear format; the
  // "Invoice no. … of …" wording is display-only (i18n), never stored.
  return `${seq}/${year}`;
};

interface ClientDoc {
  id: string;
  displayName: string;
  legalName?: string | null;
  email?: string | null;
  billingAddress?: unknown;
  vatNumber?: string | null;
}
interface InvoiceDoc {
  id: string;
  version: number;
  clientId: string;
  currency: string;
  issueDate: string;
  status: string;
  scheduledSendDate?: string | null;
  invoiceNumber?: string | null;
}

const nowTs = (): string => new Date().toISOString();

const finalizeScheduled = async (db: Db, inv: InvoiceDoc, ctx: ProcessorContext): Promise<string | null> => {
  const clients = db.collection<ClientDoc>("clients");
  const invoices = db.collection<InvoiceDoc>("invoices");
  const counters = db.collection<Counter>("counters");

  const client = await clients.findOne({ id: inv.clientId, deletedAt: null } as never, { projection: { _id: 0 } });
  const snapshot = client
    ? {
        clientId: client.id,
        displayName: client.displayName,
        legalName: client.legalName ?? null,
        email: client.email ?? null,
        billingAddress: client.billingAddress ?? null,
        vatNumber: client.vatNumber ?? null,
        currency: inv.currency,
      }
    : null;

  const year = Number(inv.issueDate.slice(0, 4));
  const invoiceNumber = await nextInvoiceNumber(counters, year);

  // Guard on the CURRENT version + still-scheduled status → exactly-once.
  const res = await invoices.findOneAndUpdate(
    { id: inv.id, version: inv.version, status: "scheduled" } as never,
    {
      $set: {
        status: "finalized",
        invoiceNumber,
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
  lineItems: LineComputed[];
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

const generateFromProfile = async (db: Db, p: ProfileDoc, ctx: ProcessorContext): Promise<string | null> => {
  const docType = p.documentType ?? "invoice";
  const cfg = DOC_CONFIG[docType];
  const profiles = db.collection<ProfileDoc>("recurringProfiles");
  const clients = db.collection<ClientDoc>("clients");
  const counters = db.collection<Counter>("counters");
  const target = db.collection<Record<string, unknown>>(cfg.collection);

  // Sum the pre-computed line money into document totals (no re-derivation).
  const subtotal = p.lineItems.reduce((s, l) => s + (l.lineSubtotalMinor ?? 0), 0);
  const discount = p.lineItems.reduce((s, l) => s + (l.lineDiscountMinor ?? 0), 0);
  const tax = p.lineItems.reduce((s, l) => s + (l.lineTaxMinor ?? 0), 0);
  const grand = p.lineItems.reduce((s, l) => s + (l.lineTotalMinor ?? 0), 0);

  const client = await clients.findOne({ id: p.clientId, deletedAt: null } as never, { projection: { _id: 0 } });
  const issueDate = p.nextRunAt;
  const year = Number(issueDate.slice(0, 4));
  const docNumber = await nextDocNumber(counters, p.accountId, cfg.series(year), cfg.prefix, year, cfg.slashYear);
  const now = nowTs();
  const docId = cryptoRandomId();

  // Advance/exhaust the profile FIRST, version-guarded → exactly-once. If another
  // tick already advanced it (version bumped), we skip (return null) BEFORE writing
  // a doc, so no duplicate is created.
  const nextRun = advanceDate(p.nextRunAt, p.interval, p.intervalCount, p.dayOfMonth);
  const generated = p.occurrencesGenerated + 1;
  const exhausted =
    (p.maxOccurrences != null && generated >= p.maxOccurrences) ||
    (p.endDate != null && nextRun > p.endDate);
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

  const clientSnapshot = client
    ? {
        clientId: client.id,
        displayName: client.displayName,
        legalName: client.legalName ?? null,
        email: client.email ?? null,
        billingAddress: client.billingAddress ?? null,
        vatNumber: client.vatNumber ?? null,
        currency: p.currency,
      }
    : null;
  const base = {
    id: docId,
    version: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    accountId: p.accountId,
    clientId: p.clientId,
    currency: p.currency,
    issueDate,
    subject: p.subject ?? null,
    lineItems: p.lineItems,
    subtotalMinor: subtotal,
    discountMinor: discount,
    taxMinor: tax,
    grandTotalMinor: grand,
    sourceRecurringProfileId: p.id,
    clientSnapshot,
  };

  let doc: Record<string, unknown>;
  if (docType === "expense") {
    // Expenses are simpler: a single amount, no line-payment/finalize lifecycle.
    doc = {
      ...base,
      expenseNumber: docNumber,
      amountMinor: grand,
      status: "recorded",
      category: "recurring",
      date: issueDate,
    };
  } else {
    // invoice + proforma share the finalized-document shape.
    doc = {
      ...base,
      dueDate: issueDate,
      amountPaidMinor: 0,
      amountDueMinor: grand,
      payments: [],
      status: docType === "invoice" ? "finalized" : "issued",
      [docType === "invoice" ? "invoiceNumber" : "proformaNumber"]: docNumber,
    };
  }
  await target.insertOne(doc as never);
  ctx.logger.info({ profileId: p.id, documentType: docType, docId, docNumber, exhausted }, "recurring occurrence generated");
  return docNumber;
};

export const recurringTickHandler = async (_payload: JobPayloads["recurring"], ctx: ProcessorContext): Promise<{ finalized: number; generated: number }> => {
  const db = await getDb();
  const invoices = db.collection<InvoiceDoc>("invoices");
  const today = todayIso();

  // Scan 1 — scheduled-send: scheduled invoices whose date has arrived.
  const due = (await invoices
    .find({ status: "scheduled", scheduledSendDate: { $lte: today }, deletedAt: null } as never, {
      projection: { _id: 0, id: 1, version: 1, clientId: 1, currency: 1, issueDate: 1, status: 1, scheduledSendDate: 1, invoiceNumber: 1 },
    })
    .toArray()) as InvoiceDoc[];

  let finalized = 0;
  for (const inv of due) {
    try {
      const num = await finalizeScheduled(db, inv, ctx);
      if (num) finalized++;
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
      const num = await generateFromProfile(db, p, ctx);
      if (num) generated++;
    } catch (err) {
      ctx.logger.error({ err, profileId: p.id }, "recurring generate failed (will retry next tick)");
    }
  }

  ctx.logger.info({ dueScheduled: due.length, finalized, dueProfiles: dueProfiles.length, generated, today }, "recurring tick complete");
  return { finalized, generated };
};
