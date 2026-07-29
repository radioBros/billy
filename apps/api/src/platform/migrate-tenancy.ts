import type { Db } from "mongodb";
import type { Logger } from "@billy/shared";
import { DEFAULT_ACCOUNT_ID } from "@/modules/auth/users.js";
import { ACCOUNT_SCOPED_COLLECTIONS } from "@/modules/accounts/service.js";

/**
 * One-time, IDEMPOTENT backfill for the single-tenant → multi-account migration.
 *
 * An install created BEFORE multi-tenancy has documents with no `accountId`. Under
 * fail-closed scoping those become invisible the moment scoping turns on. This
 * migration:
 *   1. ensures the "default" account exists (id === DEFAULT_ACCOUNT_ID, which is
 *      also the authContextFor fallback, so pre-/post-migration data align);
 *   2. stamps `accountId: "default"` on every account-scoped doc that lacks one
 *      (and settings/counters keyed differently) — only touching docs missing the
 *      field, so re-running is safe;
 *   3. attaches every account-less NON-sysadmin user to the default account;
 *   4. GUARANTEES a sysadmin exists — on an existing install, first-run bootstrap
 *      is skipped (an admin already exists), so without this nobody could manage
 *      accounts. If there is no sysadmin, the earliest active administrator is
 *      promoted to sysadmin (accountId → null).
 *
 * Safe to run on every boot. On a brand-new install it is a near-no-op (nothing to
 * backfill); first-run bootstrap then seeds the sysadmin as usual.
 */
export const migrateTenancy = async (db: Db, logger: Logger): Promise<void> => {
  const now = new Date().toISOString();

  // 1. Ensure the default account.
  const accounts = db.collection("accounts");
  const existing = await accounts.findOne({ id: DEFAULT_ACCOUNT_ID });
  if (!existing) {
    // Only create it if there is legacy data OR any user to attach — avoids
    // minting a stray account on a truly empty fresh DB (first-run handles that).
    const anyLegacy =
      (await db.collection("users").countDocuments({})) > 0 ||
      (await db.collection("clients").countDocuments({})) > 0;
    if (anyLegacy) {
      await accounts.insertOne({
        id: DEFAULT_ACCOUNT_ID,
        name: "Default",
        slug: "default",
        status: "active",
        note: "Auto-created by the multi-account migration.",
        version: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
      } as never);
      logger.info({ accountId: DEFAULT_ACCOUNT_ID }, "tenancy-migration: created default account");
    }
  }

  // 2. Stamp accountId on account-scoped docs that lack it.
  let stampedTotal = 0;
  for (const name of ACCOUNT_SCOPED_COLLECTIONS) {
    const res = await db
      .collection(name)
      .updateMany({ accountId: { $exists: false } }, { $set: { accountId: DEFAULT_ACCOUNT_ID } });
    if (res.modifiedCount > 0) {
      stampedTotal += res.modifiedCount;
      logger.info({ collection: name, stamped: res.modifiedCount }, "tenancy-migration: stamped accountId");
    }
  }

  // 3. Attach account-less non-sysadmin users to the default account.
  const usersCol = db.collection("users");
  const attached = await usersCol.updateMany(
    { role: { $ne: "sysadmin" }, $or: [{ accountId: { $exists: false } }, { accountId: null }] },
    { $set: { accountId: DEFAULT_ACCOUNT_ID } },
  );
  if (attached.modifiedCount > 0) {
    logger.info({ users: attached.modifiedCount }, "tenancy-migration: attached users to default account");
  }

  // 4. Guarantee a sysadmin exists (existing installs skip first-run bootstrap).
  const sysadminCount = await usersCol.countDocuments({ role: "sysadmin", status: "active", deletedAt: null });
  if (sysadminCount === 0) {
    const firstAdmin = await usersCol.findOne(
      { role: "administrator", status: "active", deletedAt: null },
      { sort: { createdAt: 1 } },
    );
    if (firstAdmin) {
      await usersCol.updateOne(
        { id: (firstAdmin as unknown as { id: string }).id },
        { $set: { role: "sysadmin", accountId: null, updatedAt: now } },
      );
      logger.warn(
        { userId: (firstAdmin as unknown as { id: string }).id },
        "tenancy-migration: promoted earliest administrator to sysadmin (no sysadmin existed)",
      );
    }
  }

  if (stampedTotal > 0 || attached.modifiedCount > 0) {
    logger.info({ stampedTotal }, "tenancy-migration: complete");
  }
};
