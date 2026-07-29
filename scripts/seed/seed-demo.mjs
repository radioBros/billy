#!/usr/bin/env node
/**
 * Billy — comprehensive DEMO data seed.
 *
 * Populates the running stack with realistic demo data across EVERY module so a
 * fresh self-hoster can explore the whole product immediately: 2 users (admin +
 * a restricted member), company + individual clients, quotes in every state,
 * invoices in every state (incl. a past-due one), payments, a credit note, a
 * proforma, a recurring-billing profile, a subscription, time entries, expenses
 * (with a receipt file), a contract (with a document file), a branding logo +
 * SMTP config, and generated invoice PDFs — plus some backdated records so the
 * dashboard's recent-activity looks alive.
 *
 * DESIGN (see the deployment notes):
 *  - Runs INSIDE the stack's network (`docker compose run --rm --no-deps api
 *    node scripts/seed/seed-demo.mjs`) so it reaches the api at http://api:3000,
 *    Mongo at mongodb:27017, and — crucially — the presigned MinIO upload URLs
 *    (which point at minio:9000, only resolvable on the internal network).
 *  - USERS are written directly to Mongo (no user-management HTTP endpoint yet),
 *    reusing the api image's baked @node-rs/argon2 for password hashing.
 *  - ALL BUSINESS DATA goes through the HTTP API, so money is server-recomputed,
 *    numbering is real, and every invariant holds — the demo data is valid by
 *    construction, never hand-forged.
 *  - RESET-THEN-SEED for idempotency: wipes demo collections + numbering counters
 *    + the MinIO bucket, then seeds fresh → deterministic state every run.
 *
 * SAFETY: refuses to run when APP_ENV=production (it creates known-password users
 * and wipes collections). Override only with --force-insecure (never in prod).
 */
import { MongoClient, ObjectId } from "mongodb";
import { hash as argon2hash } from "@node-rs/argon2";
import { Client as MinioClient } from "minio";

// ── Config from env (same .env the api uses) ─────────────────────────────────
const APP_ENV = process.env.APP_ENV ?? "development";
const FORCE = process.argv.includes("--force-insecure");
const API = process.env.SEED_API_URL ?? "http://api:3000";
const MONGO_URI = process.env.MONGO_URI ?? "mongodb://mongodb:27017/billy";
// files-storage uses its OWN bucket constant (FILES_BUCKET = "billy-files"),
// NOT the generic MINIO_BUCKET env (which defaults to "billy"). Hardcode to match.
const MINIO_BUCKET = "billy-files";
// Multi-tenant demo: TWO accounts so the account switcher + isolation are testable.
const DEMO_ACCOUNT_ID = "demo";
const SECOND_ACCOUNT_ID = "second";
// Global sysadmin (manages accounts + switches between them).
const SYSADMIN_EMAIL = "sysadmin@billy.local";
const SYSADMIN_PASSWORD = "demo-Sysadmin-123";
// Account #1 (Demo Company) — the rich demo dataset.
const ADMIN_EMAIL = "admin@billy.local";
const ADMIN_PASSWORD = "demo-Admin-123";
const MEMBER_EMAIL = "member@billy.local";
const MEMBER_PASSWORD = "demo-Member-123";
// Account #2 (Second Co) — a small dataset to prove isolation/switching.
const ADMIN2_EMAIL = "admin@second.local";
const ADMIN2_PASSWORD = "demo-Admin2-123";

if (APP_ENV === "production" && !FORCE) {
  console.error("REFUSING to seed: APP_ENV=production. Demo seed creates known-password users and wipes data.");
  console.error("If you REALLY mean it (you almost never do), re-run with --force-insecure.");
  process.exit(1);
}

const log = (...a) => console.log("[seed]", ...a);
const iso = (d) => new Date(d).toISOString();
const daysAgo = (n) => iso(Date.now() - n * 86400000);
const dateOnly = (n) => daysAgo(n).slice(0, 10);
const dateAhead = (n) => iso(Date.now() + n * 86400000).slice(0, 10);

// ── Year/month spread helpers (for populated per-year charts + heatmap) ───────
const NOW = new Date();
const CURRENT_YEAR = NOW.getUTCFullYear();
const PRIOR_YEAR = CURRENT_YEAR - 1;
const CURRENT_MONTH = NOW.getUTCMonth() + 1; // 1..12
/** `YYYY-MM-DD` for the given year/month(1..12)/day, clamped to a valid day. */
const ymd = (year, month, day = 15) => {
  const d = Math.min(day, 28); // safe for every month
  return `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};
/** Add `n` days to a `YYYY-MM-DD` string, return `YYYY-MM-DD`. */
const addDays = (dateStr, n) => iso(new Date(`${dateStr}T00:00:00.000Z`).getTime() + n * 86400000).slice(0, 10);
/**
 * Enumerate {year, month} buckets to spread docs over: ALL 12 months of the
 * prior year, plus months 1..CURRENT_MONTH of the current year (so we never
 * date a document into the future). Returns e.g. 12 + current-month entries.
 */
const spreadMonths = () => {
  const out = [];
  for (let m = 1; m <= 12; m++) out.push({ year: PRIOR_YEAR, month: m });
  for (let m = 1; m <= CURRENT_MONTH; m++) out.push({ year: CURRENT_YEAR, month: m });
  return out;
};

// ── argon2 params must match apps/api password.ts (else verifyPassword fails) ─
// password.ts uses @node-rs/argon2 defaults (Argon2id); hash() with no opts matches.
const hashPassword = (plain) => argon2hash(plain);

// ── HTTP helper (session-cookie auth, same as a browser) ─────────────────────
let COOKIE = "";
async function api(method, path, body, { expect = null } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(COOKIE ? { cookie: COOKIE } : {}),
      // dev api sets a non-secure cookie; in case APP_ENV were prod+forced, pretend TLS.
      "x-forwarded-proto": "https",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) COOKIE = setCookie.split(";")[0];
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (expect && res.status !== expect) {
    throw new Error(`${method} ${path} → ${res.status} (expected ${expect}): ${text.slice(0, 300)}`);
  }
  if (json?.error) throw new Error(`${method} ${path} → API error ${json.error.code}: ${json.error.message}`);
  return json?.data ?? json;
}

// ── Minimal valid file bytes (for the real upload flow) ──────────────────────
// 1×1 transparent PNG.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
// Smallest valid-ish PDF.
const PDF_MIN = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]>>endobj\nxref\n0 4\n0000000000 65535 f \ntrailer<</Root 1 0 R/Size 4>>\nstartxref\n0\n%%EOF",
  "latin1",
);

/** Upload a file via the real request-upload → PUT → confirm flow. Returns fileId. */
async function uploadFile(ownerType, ownerId, filename, contentType, bytes) {
  const req = await api("POST", "/api/v1/files/request-upload", {
    ownerType,
    ownerId,
    filename,
    contentType,
    sizeBytes: bytes.length,
  });
  // The uploadUrl is a presigned PUT at minio:9000 — resolvable on this network.
  const put = await fetch(req.uploadUrl, { method: "PUT", body: bytes, headers: { "content-type": contentType } });
  if (!put.ok) throw new Error(`upload PUT failed ${put.status} for ${filename}`);
  await api("POST", `/api/v1/files/${req.file.id}/confirm`, { sizeBytes: bytes.length, contentType });
  return req.file.id;
}

// ── Reset (wipe demo collections + counters + MinIO objects) ─────────────────
const BUSINESS_COLLECTIONS = [
  "clients", "quotes", "invoices", "creditNotes", "proformas",
  "recurringProfiles", "subscriptions", "timeEntries", "expenses",
  "contracts", "notifications", "notificationPreferences", "files", "userSettings",
  "projects",
];

async function reset(db) {
  log("reset: wiping demo collections…");
  for (const c of BUSINESS_COLLECTIONS) await db.collection(c).deleteMany({});
  // Numbering counters live in the dedicated `counters` collection (NOT settings).
  // Each counter carries an accountId (per-account series); wipe both demo accounts'.
  await db.collection("counters").deleteMany({ accountId: { $in: [DEMO_ACCOUNT_ID, SECOND_ACCOUNT_ID] } });
  // Per-account settings singletons for both demo accounts.
  await db.collection("settings").deleteMany({ accountId: { $in: [DEMO_ACCOUNT_ID, SECOND_ACCOUNT_ID] } });
  // The two demo accounts themselves (recreated by seedUsers).
  await db.collection("accounts").deleteMany({ id: { $in: [DEMO_ACCOUNT_ID, SECOND_ACCOUNT_ID] } });
  // All seed users (sysadmin + both accounts' users). Leaves any operator-created
  // users on OTHER accounts intact.
  await db.collection("users").deleteMany({
    email: { $in: [SYSADMIN_EMAIL, ADMIN_EMAIL, MEMBER_EMAIL, ADMIN2_EMAIL] },
  });
  // MinIO objects.
  try {
    const minio = new MinioClient({
      endPoint: process.env.MINIO_ENDPOINT ?? "minio",
      port: Number(process.env.MINIO_PORT ?? 9000),
      useSSL: (process.env.MINIO_USE_SSL ?? "false") === "true",
      accessKey: process.env.MINIO_ROOT_USER ?? process.env.MINIO_ACCESS_KEY ?? "billy-admin",
      secretKey: process.env.MINIO_ROOT_PASSWORD ?? process.env.MINIO_SECRET_KEY ?? "change-me-in-env",
    });
    const objs = [];
    await new Promise((resolve, reject) => {
      const stream = minio.listObjectsV2(MINIO_BUCKET, "", true);
      stream.on("data", (o) => objs.push(o.name));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    if (objs.length) await minio.removeObjects(MINIO_BUCKET, objs);
    log(`reset: removed ${objs.length} MinIO objects`);
  } catch (e) {
    log("reset: MinIO wipe skipped:", e.message);
  }
}

// ── Users (direct Mongo, reusing the api image's argon2) ─────────────────────
async function seedUsers(db) {
  log("users: creating sysadmin + 2 accounts (each with admin + member)…");
  const now0 = iso(Date.now());

  const mkAccount = async (id, name, slug) => {
    await db.collection("accounts").updateOne(
      { id },
      {
        $setOnInsert: {
          id, name, slug, status: "active", note: "Seeded demo account.",
          version: 1, createdAt: now0, updatedAt: now0, archivedAt: null, deletedAt: null,
        },
      },
      { upsert: true },
    );
  };
  await mkAccount(DEMO_ACCOUNT_ID, "Demo Company", "demo");
  await mkAccount(SECOND_ACCOUNT_ID, "Second Co", "second");

  // accountId = null ONLY for the global sysadmin.
  const mk = async (email, password, displayName, role, capabilities, accountId) => {
    const now = iso(Date.now());
    await db.collection("users").insertOne({
      id: new ObjectId().toHexString(),
      version: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      email: email.toLowerCase(),
      displayName,
      passwordHash: await hashPassword(password),
      role,
      accountId,
      capabilities,
      status: "active",
      emailVerifiedAt: now,
      mustChangePassword: false, // demo users shouldn't nag
      failedLoginCount: 0,
      lockedUntil: null,
    });
  };
  const FULL = {
    canManageSettings: true, canManageUsers: true, canPermanentlyDelete: true,
    canViewFinancialTotals: true, canExportData: true,
  };
  const MEMBER_CAPS = {
    canManageSettings: false, canManageUsers: false, canPermanentlyDelete: false,
    canViewFinancialTotals: false, canExportData: false,
  };
  // Global sysadmin — manages accounts, switches between them.
  await mk(SYSADMIN_EMAIL, SYSADMIN_PASSWORD, "System Administrator", "sysadmin", FULL, null);
  // Account #1 (Demo Company): admin + restricted member.
  await mk(ADMIN_EMAIL, ADMIN_PASSWORD, "Demo Admin", "administrator", FULL, DEMO_ACCOUNT_ID);
  await mk(MEMBER_EMAIL, MEMBER_PASSWORD, "Demo Member", "member", MEMBER_CAPS, DEMO_ACCOUNT_ID);
  // Account #2 (Second Co): its own admin.
  await mk(ADMIN2_EMAIL, ADMIN2_PASSWORD, "Second Co Admin", "administrator", FULL, SECOND_ACCOUNT_ID);
}

// ── Business data (all via HTTP as the admin) ────────────────────────────────
async function login() {
  await api("POST", "/api/v1/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, { expect: 200 });
  log("logged in as admin (Demo Company)");
}

/** Log in as an arbitrary user (resets the module session cookie to theirs). */
async function loginAs(email, password) {
  await api("POST", "/api/v1/auth/login", { email, password }, { expect: 200 });
}

/**
 * Second account (Second Co): a SMALL dataset under its own admin, so the
 * account switcher + tenant isolation are visibly testable — its clients/invoices
 * never appear in Demo Company and vice-versa. Also seeds a project and assigns an
 * invoice to it (exercises the projectId FK).
 */
async function seedSecondAccount() {
  log("second account (Second Co): project + clients + an invoice…");
  await loginAs(ADMIN2_EMAIL, ADMIN2_PASSWORD);
  const project = await api("POST", "/api/v1/projects", {
    name: "Website Rebuild", description: "2026 site redesign",
  }).catch((e) => { log("  project:", e.message); return null; });
  const initech = await api("POST", "/api/v1/clients", {
    type: "company", displayName: "Initech LLC", legalName: "Initech LLC",
    email: "ap@initech.example", vatNumber: "US123456789", preferredCurrency: "USD",
    billingAddress: { line1: "1 Office Park", city: "Austin", postalCode: "73301", country: "US" },
  });
  await api("POST", "/api/v1/clients", {
    type: "individual", displayName: "Sam Buyer", firstName: "Sam", lastName: "Buyer",
    email: "sam@buyer.example", preferredCurrency: "USD",
  });
  await api("POST", "/api/v1/invoices", {
    clientId: initech.id,
    projectId: project?.id ?? null,
    currency: "USD",
    issueDate: dateOnly(5),
    dueDate: dateAhead(25),
    lineItems: [LI("Design sprint", 1, 480000)],
    notes: "Second Co — isolated from Demo Company.",
  }).catch((e) => log("  invoice:", e.message));
}

// Stable ids for the demo bank accounts so invoice creates can reference them.
const BANK_PRIMARY_ID = "bank-primary";
const BANK_SECONDARY_ID = "bank-secondary";

async function seedSettings() {
  log("settings: business (+ bank accounts) + branding (logo) + documents + localization…");
  await api("PATCH", "/api/v1/settings/business", {
    businessName: "Billy Demo Co.", legalName: "Billy Demo Co. Ltd",
    vatNumber: "IT01234567890", taxCode: "BLLYDM00A01H501Z",
    email: "billing@billy.demo", phone: "+39 06 1234567",
    address: { line1: "Via Ridolfino Venuti 30", city: "Roma", postalCode: "00162", region: "RM", country: "IT" },
    // Multi-bank: two named accounts (freeform textarea details). Invoices below
    // pick one via bankAccountId, which the API snapshots onto the invoice.
    bankAccounts: [
      { id: BANK_PRIMARY_ID, label: "Primary — UniCredit",
        details: "UniCredit S.p.A.\nIBAN IT60 X054 2811 1010 0000 0123 456\nBIC UNCRITMM" },
      { id: BANK_SECONDARY_ID, label: "Secondary — Intesa",
        details: "Intesa Sanpaolo\nIBAN IT12 A030 6909 6061 0000 0012 345\nBIC BCITITMM" },
    ],
  }).catch((e) => log("  business settings:", e.message));
  // Branding colors only. We deliberately do NOT set logoFileId — leaving it
  // unset makes the app show its bundled horizontal billy logo (/billy.png) in
  // the shell + app bar. (An operator uploads their own logo via the
  // Customization panel to white-label; that path is exercised by the file
  // upload flow used elsewhere in this seed.)
  await api("PATCH", "/api/v1/settings/branding", {
    appName: "Billy", logoFileId: null, primaryColor: "#5b5bd6", secondaryColor: "#22c55e",
  }).catch((e) => log("  branding:", e.message));
  // Documents group: layout + document/email/contract header-footer HTML.
  await api("PATCH", "/api/v1/settings/documents", {
    logoPosition: "left",
    showBankDetails: true,
    documentFooterHtml: "<p>Billy Demo Co. Ltd — VAT IT01234567890 — billing@billy.demo</p>",
    contractHeaderHtml: "<h2>Service Agreement</h2>",
    contractFooterHtml: "<p>This contract is governed by the laws of Italy.</p>",
    emailHeaderHtml: "<p><strong>Billy Demo Co.</strong></p>",
    emailFooterHtml: "<p>Questions? Reply to this email or write billing@billy.demo.</p>",
  }).catch((e) => log("  documents settings:", e.message));
  await api("PATCH", "/api/v1/settings/localization", {
    defaultCurrency: "EUR", defaultLocale: "en", timezone: "Europe/Rome",
  }).catch((e) => log("  localization:", e.message));
  // SMTP configured (write-only; test-send uses jsonTransport in dev).
  await api("PATCH", "/api/v1/settings/email", {
    smtpHost: "smtp.demo.local", smtpPort: 587, smtpUsername: "demo", smtpPassword: "demo-secret",
    fromEmail: "billing@billy.demo", fromName: "Billy Demo",
  }).catch((e) => log("  email settings:", e.message));
}

async function seedClients() {
  log("clients: company + individual…");
  const acme = await api("POST", "/api/v1/clients", {
    type: "company", displayName: "Acme S.p.A.", legalName: "Acme S.p.A.",
    email: "ap@acme.example", phone: "+39 02 1234567", vatNumber: "IT09876543210",
    billingAddress: { line1: "Via Roma 10", city: "Milano", postalCode: "20100", country: "IT" },
    preferredCurrency: "EUR", tags: ["vip", "manufacturing"],
  });
  const globex = await api("POST", "/api/v1/clients", {
    type: "company", displayName: "Globex Srl", legalName: "Globex S.r.l.",
    email: "finance@globex.example", vatNumber: "IT11122233344",
    preferredCurrency: "EUR", tags: ["retail"],
  });
  const jane = await api("POST", "/api/v1/clients", {
    type: "individual", displayName: "Jane Roe", firstName: "Jane", lastName: "Roe",
    email: "jane@roe.example", phone: "+39 333 9998877", preferredCurrency: "EUR",
  });
  return { acme, globex, jane };
}

const LI = (desc, qty, unit, tax = 22, disc) => ({
  description: desc, quantity: qty, unitPriceMinor: unit, taxRate: tax, ...(disc ? { discountRate: disc } : {}),
});

async function seedQuotes(clients) {
  log("quotes: draft / sent / accepted / declined…");
  const mk = (client, issueOffset) =>
    api("POST", "/api/v1/quotes", {
      clientId: client.id, currency: "EUR",
      issueDate: dateOnly(issueOffset), expiryDate: dateAhead(30),
      lineItems: [LI("Discovery workshop", 1, 150000), LI("Prototype", 2, 80000, 22, 10)],
      notes: "Demo quote.",
    });
  // Transitions require the optimistic-concurrency `version` (bumps each step).
  const act = (id, action, version) => api("POST", `/api/v1/quotes/${id}/${action}`, { version });

  const draft = await mk(clients.acme, 5); // stays draft

  const sent = await mk(clients.globex, 8);
  const sent2 = await act(sent.id, "send", sent.version); // v1→v2
  await act(sent2.id, "share", sent2.version).catch((e) => log("  quote share:", e.message)); // mint token

  const accepted = await mk(clients.acme, 20);
  const acc2 = await act(accepted.id, "send", accepted.version);
  await act(acc2.id, "accept", acc2.version).catch((e) => log("  quote accept:", e.message));

  const declined = await mk(clients.jane, 15);
  const dec2 = await act(declined.id, "send", declined.version);
  await act(dec2.id, "decline", dec2.version).catch((e) => log("  quote decline:", e.message));

  return { draft, sent, accepted, declined };
}

async function seedInvoices(clients) {
  log("invoices: draft / finalized / partially-paid / paid / overdue…");
  const mk = (client, issueOffset, dueOffsetAhead, lines, bankAccountId = BANK_PRIMARY_ID) =>
    api("POST", "/api/v1/invoices", {
      clientId: client.id, currency: "EUR",
      issueDate: dateOnly(issueOffset),
      dueDate: dueOffsetAhead >= 0 ? dateAhead(dueOffsetAhead) : dateOnly(-dueOffsetAhead),
      lineItems: lines,
      // The API snapshots the chosen bank account's {label, details} onto the invoice.
      bankAccountId,
      notes: "Thank you for your business.",
    });
  const finalize = (inv, v = 1) => api("POST", `/api/v1/invoices/${inv.id}/finalize`, { version: v });
  const pay = (inv, amount, v, method = "bank_transfer") =>
    api("POST", `/api/v1/invoices/${inv.id}/payments`, { amountMinor: amount, date: dateOnly(1), method, version: v });

  // draft
  const draft = await mk(clients.acme, 3, 30, [LI("Consulting", 4, 12000)]);
  // finalized (unpaid, not due yet)
  const fin = await mk(clients.globex, 10, 20, [LI("Licensing", 1, 500000)]);
  await finalize(fin);
  // partially paid
  const part = await mk(clients.acme, 25, 5, [LI("Retainer", 1, 300000)]);
  const partFin = await finalize(part); // v→2
  await pay(part, 100000, partFin.version); // partial
  // fully paid
  const paid = await mk(clients.jane, 40, 30, [LI("Website", 1, 250000, 22, 5)]);
  const paidFin = await finalize(paid);
  await pay(paid, paidFin.grandTotalMinor, paidFin.version);
  // OVERDUE = finalized + past dueDate + unpaid (dueDate 15 days ago)
  const overdue = await mk(clients.globex, 45, -15, [LI("Support hours", 10, 9000)]);
  await finalize(overdue);
  // share one publicly (invoice /share is idempotent; needs the current version).
  const paidNow = await api("GET", `/api/v1/invoices/${paid.id}`).catch(() => null);
  if (paidNow) await api("POST", `/api/v1/invoices/${paid.id}/share`, { version: paidNow.version }).catch((e) => log("  invoice share:", e.message));
  // generate a PDF for the paid invoice (worker renders it)
  await api("GET", `/api/v1/invoices/${paid.id}/pdf`).catch(() => {});
  await api("GET", `/api/v1/invoices/${fin.id}/pdf`).catch(() => {});
  return { draft, fin, part, paid, overdue };
}

async function seedCreditNote(clients, invoices) {
  log("credit note: against the paid invoice…");
  return api("POST", "/api/v1/credit-notes", {
    clientId: clients.jane.id, creditedInvoiceId: invoices.paid.id, currency: "EUR",
    issueDate: dateOnly(2), reason: "Partial service credit",
    lineItems: [LI("Credit — 1 day", 1, 50000)],
  }).catch((e) => log("  credit-note:", e.message));
}

async function seedProforma(clients) {
  log("proforma…");
  return api("POST", "/api/v1/proformas", {
    clientId: clients.acme.id, currency: "EUR", issueDate: dateOnly(1),
    expiryDate: dateAhead(14),
    lineItems: [LI("Advance estimate", 3, 70000)],
  }).catch((e) => log("  proforma:", e.message));
}

async function seedRecurringAndSubs(clients) {
  log("recurring profile + subscription…");
  await api("POST", "/api/v1/recurring-profiles", {
    clientId: clients.acme.id, currency: "EUR", interval: "monthly", intervalCount: 1,
    startDate: dateOnly(60), lineItems: [LI("Monthly hosting", 1, 9900)],
    notes: "Auto-generated monthly.",
  }).catch((e) => log("  recurring:", e.message));
  await api("POST", "/api/v1/subscriptions", {
    clientId: clients.globex.id, name: "Pro Plan", plan: "pro", currency: "EUR",
    interval: "monthly", amountMinor: 4900, startDate: dateOnly(90), nextBillingDate: dateAhead(10),
  }).catch((e) => log("  subscription:", e.message));
}

async function seedTimeAndExpenses(clients) {
  log("time entries + expenses (with receipt file)…");
  await api("POST", "/api/v1/time-entries", {
    clientId: clients.acme.id, description: "Client meeting", date: dateOnly(2),
    durationMinutes: 90, billable: true, rateMinor: 12000,
  }).catch((e) => log("  time entry (billable):", e.message));
  await api("POST", "/api/v1/time-entries", {
    description: "Internal planning", date: dateOnly(3), durationMinutes: 120, billable: false,
  }).catch((e) => log("  time entry (non-billable):", e.message));
  // Expense with a receipt file.
  const exp = await api("POST", "/api/v1/expenses", {
    amountMinor: 4599, currency: "EUR", category: "Software", date: dateOnly(4),
    vendor: "SaaS Vendor", description: "Monthly tooling", billable: true, clientId: clients.acme.id,
  }).catch((e) => { log("  expense:", e.message); return null; });
  if (exp?.id) {
    await uploadFile("expense", exp.id, "receipt.pdf", "application/pdf", PDF_MIN).catch((e) =>
      log("  receipt upload:", e.message),
    );
  }
}

async function seedContract(clients) {
  log("contract (with document file)…");
  const c = await api("POST", "/api/v1/contracts", {
    clientId: clients.acme.id, title: "Master Services Agreement", type: "service_agreement",
    startDate: dateOnly(60), endDate: dateAhead(305), valueMinor: 1200000, currency: "EUR",
    terms: "Net 30. Demo contract.",
  }).catch((e) => { log("  contract:", e.message); return null; });
  if (c?.id) {
    await uploadFile("contract", c.id, "msa.pdf", "application/pdf", PDF_MIN).catch((e) =>
      log("  contract doc:", e.message),
    );
  }
}

// ── Monthly spread (volume across 12 months of prior + current year) ─────────
// Dates the BUCKET field of each doc type (issueDate / startDate / date), not
// just createdAt, so the per-year revenue/expense line, the monthly-counts
// chart, and the heatmap are all populated across every month. Everything goes
// through the HTTP API so money/numbering/invariants stay valid by construction.
async function seedMonthlySpread(clients) {
  const buckets = spreadMonths();
  log(`monthly spread: ${buckets.length} month-buckets (${PRIOR_YEAR} full year + ${CURRENT_YEAR} to date)…`);
  const clientList = [clients.acme, clients.globex, clients.jane];
  const pick = (i) => clientList[i % clientList.length];

  // Small helper actions (mirror seedInvoices) — need the optimistic version.
  const finalizeInv = (inv) => api("POST", `/api/v1/invoices/${inv.id}/finalize`, { version: inv.version });
  const payInv = (inv, amount, v, date) =>
    api("POST", `/api/v1/invoices/${inv.id}/payments`, { amountMinor: amount, date, method: "bank_transfer", version: v });

  let idx = 0;
  let counts = { invoices: 0, quotes: 0, proformas: 0, creditNotes: 0, contracts: 0, expenses: 0 };
  for (const { year, month } of buckets) {
    const client = pick(idx);
    const issue = ymd(year, month, 8 + (idx % 18)); // vary the day
    const base = 40000 + ((idx * 37) % 20) * 5000; // vary the amount

    // INVOICE — rotate statuses across a repeating cycle so every month has
    // some issued (finalized/partially-paid/paid/overdue) invoices.
    let paidInvoiceId = null; // a fully-paid invoice this month → creditable
    try {
      const inv = await api("POST", "/api/v1/invoices", {
        clientId: client.id, currency: "EUR", issueDate: issue,
        dueDate: addDays(issue, 30),
        lineItems: [LI(`Services ${year}-${month}`, 1 + (idx % 3), base)],
        bankAccountId: idx % 2 === 0 ? BANK_PRIMARY_ID : BANK_SECONDARY_ID,
      });
      const cycle = idx % 4;
      if (cycle !== 3) {
        // 0=finalized (open), 1=partially paid, 2=paid; 3 stays draft (excluded from charts)
        const fin = await finalizeInv(inv);
        if (cycle === 1) await payInv(fin, Math.round(fin.grandTotalMinor / 3), fin.version, addDays(issue, 5));
        else if (cycle === 2) {
          await payInv(fin, fin.grandTotalMinor, fin.version, addDays(issue, 5));
          paidInvoiceId = fin.id;
        }
      }
      counts.invoices++;
    } catch (e) { log(`  spread invoice ${year}-${month}:`, e.message); }

    // QUOTE — issued (sent) so it counts; some accepted.
    try {
      const q = await api("POST", "/api/v1/quotes", {
        clientId: client.id, currency: "EUR", issueDate: issue, expiryDate: addDays(issue, 30),
        lineItems: [LI(`Proposal ${year}-${month}`, 1, base + 10000)],
      });
      const sent = await api("POST", `/api/v1/quotes/${q.id}/send`, { version: q.version });
      if (idx % 3 === 0) await api("POST", `/api/v1/quotes/${sent.id}/accept`, { version: sent.version }).catch(() => {});
      counts.quotes++;
    } catch (e) { log(`  spread quote ${year}-${month}:`, e.message); }

    // PROFORMA — issue it so it counts (not a draft).
    if (idx % 2 === 0) {
      try {
        const p = await api("POST", "/api/v1/proformas", {
          clientId: client.id, currency: "EUR", issueDate: issue, expiryDate: addDays(issue, 21),
          lineItems: [LI(`Advance ${year}-${month}`, 2, base)],
        });
        await api("POST", `/api/v1/proformas/${p.id}/issue`, { version: p.version }).catch((e) => log("  proforma issue:", e.message));
        counts.proformas++;
      } catch (e) { log(`  spread proforma ${year}-${month}:`, e.message); }
    }

    // CREDIT NOTE — against a fully-paid invoice from this month (requires a
    // creditedInvoiceId). Only when this iteration produced a paid invoice.
    if (paidInvoiceId) {
      try {
        const cn = await api("POST", "/api/v1/credit-notes", {
          clientId: client.id, creditedInvoiceId: paidInvoiceId, currency: "EUR",
          issueDate: issue, reason: "Adjustment",
          lineItems: [LI(`Credit ${year}-${month}`, 1, Math.round(base / 2))],
        });
        await api("POST", `/api/v1/credit-notes/${cn.id}/issue`, { version: cn.version }).catch((e) => log("  credit-note issue:", e.message));
        counts.creditNotes++;
      } catch (e) { log(`  spread credit-note ${year}-${month}:`, e.message); }
    }

    // CONTRACT — startDate spread across months (counted by startDate, any status).
    if (idx % 3 !== 2) {
      try {
        await api("POST", "/api/v1/contracts", {
          clientId: client.id, title: `Agreement ${year}-${month}`, type: "service_agreement",
          startDate: issue, endDate: addDays(issue, 300), valueMinor: base * 10, currency: "EUR",
          terms: "Net 30.",
        });
        counts.contracts++;
      } catch (e) { log(`  spread contract ${year}-${month}:`, e.message); }
    }

    // EXPENSE — 1-2 per month, dated within the month.
    try {
      await api("POST", "/api/v1/expenses", {
        amountMinor: 1500 + ((idx * 13) % 40) * 100, currency: "EUR",
        category: ["Software", "Travel", "Office", "Marketing"][idx % 4],
        date: issue, vendor: `Vendor ${idx % 7}`, description: `Cost ${year}-${month}`,
        billable: idx % 2 === 0, clientId: client.id,
      });
      counts.expenses++;
      if (idx % 3 === 0) {
        await api("POST", "/api/v1/expenses", {
          amountMinor: 800 + ((idx * 7) % 30) * 100, currency: "EUR",
          category: "Office", date: addDays(issue, 3), vendor: "Sundry", description: "Extra cost",
        });
        counts.expenses++;
      }
    } catch (e) { log(`  spread expense ${year}-${month}:`, e.message); }

    idx++;
  }
  log(`monthly spread done: ${JSON.stringify(counts)}`);
}

// ── Notifications (direct — normally event-driven; demo needs read + unread) ──
async function seedNotifications(db) {
  log("notifications: read + unread for both users…");
  const admin = await db.collection("users").findOne({ email: ADMIN_EMAIL });
  const member = await db.collection("users").findOne({ email: MEMBER_EMAIL });
  const mk = (userId, category, title, body, unread, ago) => ({
    id: new ObjectId().toHexString(),
    version: 1,
    createdAt: daysAgo(ago),
    updatedAt: daysAgo(ago),
    archivedAt: null,
    deletedAt: null,
    userId,
    businessScope: "default",
    category,
    type: `${category}.demo`,
    title,
    body,
    entityType: null,
    entityId: null,
    readAt: unread ? null : daysAgo(ago),
  });
  const docs = [];
  for (const u of [admin, member].filter(Boolean)) {
    docs.push(mk(u.id, "invoices", "Invoice paid", "INV-2026-0004 was paid in full.", false, 3));
    docs.push(mk(u.id, "quotes", "Quote accepted", "A client accepted your quote.", true, 1));
    docs.push(mk(u.id, "system", "Welcome to Billy", "Your demo workspace is ready.", true, 0));
  }
  if (docs.length) await db.collection("notifications").insertMany(docs);
}

// ── Backdate some records so the dashboard's recent-activity looks alive ──────
async function backdateForDashboard(db) {
  log("backdate: spreading createdAt across the last 30 days for dashboard realism…");
  const spread = async (coll) => {
    const docs = await db.collection(coll).find({}).toArray();
    let i = 0;
    for (const d of docs) {
      const back = daysAgo((i % 28) + 1);
      await db.collection(coll).updateOne({ _id: d._id }, { $set: { createdAt: back } });
      i++;
    }
  };
  for (const c of ["clients", "invoices", "quotes", "expenses", "timeEntries"]) await spread(c);
}

async function main() {
  log(`env=${APP_ENV} api=${API} bucket=${MINIO_BUCKET}`);
  const mongo = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await mongo.connect();
  const db = mongo.db();
  try {
    await reset(db);
    await seedUsers(db);
    await login();
    await seedSettings();
    const clients = await seedClients();
    await seedQuotes(clients);
    const invoices = await seedInvoices(clients);
    await seedCreditNote(clients, invoices);
    await seedProforma(clients);
    await seedRecurringAndSubs(clients);
    await seedTimeAndExpenses(clients);
    await seedContract(clients);
    await seedMonthlySpread(clients);
    await seedNotifications(db);
    await backdateForDashboard(db);
    // Second account — a small isolated dataset (also proves the projectId FK).
    await seedSecondAccount();
    log("");
    log("✅ Demo seed complete (multi-account).");
    log("   Sysadmin      : " + SYSADMIN_EMAIL + " / " + SYSADMIN_PASSWORD + "  (manages accounts; use the top-bar switcher)");
    log("   Demo Company  — Admin : " + ADMIN_EMAIL + " / " + ADMIN_PASSWORD);
    log("   Demo Company  — Member: " + MEMBER_EMAIL + " / " + MEMBER_PASSWORD + "  (restricted: no financial totals)");
    log("   Second Co     — Admin : " + ADMIN2_EMAIL + " / " + ADMIN2_PASSWORD);
  } finally {
    await mongo.close();
  }
}

main().catch((e) => {
  console.error("[seed] FAILED:", e.stack ?? e.message);
  process.exit(1);
});
