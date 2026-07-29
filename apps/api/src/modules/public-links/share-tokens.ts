import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Collection, Db } from "mongodb";

/**
 * Share-token store. The RAW token is high-entropy
 * (256-bit CSPRNG, base64url) and returned to the caller ONCE (it goes in the
 * share URL); only its **SHA-256 hash** is persisted — no raw token is ever
 * stored or logged. Resolution hashes the incoming token, does an INDEXED lookup
 * by `tokenHash`, then a constant-time compare, and treats any miss identically
 * (the caller maps to a uniform 404 → no enumeration/timing oracle).
 *
 * Scope: storage + generation + resolution only. The nullable
 * `expiresAt`/`revokedAt`/`lastAccessedAt` columns are in the schema for
 * future revoke/expire work but NO revoke/expire/viewed logic is built
 * here — resolution ignores them for now.
 *
 * One active token per document: re-sharing ROTATES (supersedes the prior row),
 * so the old link stops resolving. This is why a hashed store cannot "return the
 * existing raw token" — the raw is unrecoverable by design.
 */

export const SHARE_TOKENS_COLLECTION = "shareTokens";

export type ShareDocumentType = "quote" | "invoice";

export interface ShareToken {
 /** SHA-256 hex of the raw token — the only representation at rest. Unique-indexed. */
  tokenHash: string;
  documentType: ShareDocumentType;
  documentId: string;
  createdBy: string;
  createdAt: string; // UTC ISO
 /** Future: revocation/expiry. Present in the schema, unused by resolve today. */
  expiresAt?: string | null;
  revokedAt?: string | null;
  lastAccessedAt?: string | null;
}

export const hashToken = (raw: string): string => {
  return createHash("sha256").update(raw, "utf8").digest("hex");
};

const timingSafeHexEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
};

export class ShareTokenStore {
  private readonly col: Collection<ShareToken>;
  constructor(db: Db) {
    this.col = db.collection<ShareToken>(SHARE_TOKENS_COLLECTION);
  }

 /** Idempotently ensure the indexes (unique tokenHash; lookup by document). */
  async ensureIndexes(): Promise<void> {
    await this.col.createIndex({ tokenHash: 1 }, { unique: true });
    await this.col.createIndex({ documentType: 1, documentId: 1 });
  }

 /**
 * Mint a fresh share token for a document, ROTATING any prior token (one active
 * per document — the old link dies). Returns the RAW token (caller puts it in
 * the URL); only the hash is stored. 256-bit entropy.
 */
  async mint(documentType: ShareDocumentType, documentId: string, createdBy: string): Promise<string> {
    const raw = randomBytes(32).toString("base64url"); // 256-bit
    const tokenHash = hashToken(raw);
    const now = new Date().toISOString();
 // Supersede any existing token(s) for this document (rotation).
    await this.col.deleteMany({ documentType, documentId } as never);
    await this.col.insertOne({
      tokenHash,
      documentType,
      documentId,
      createdBy,
      createdAt: now,
      expiresAt: null,
      revokedAt: null,
      lastAccessedAt: null,
    });
    return raw;
  }

 /** Revoke all tokens for a document (delete the rows → links stop resolving). */
  async revokeForDocument(documentType: ShareDocumentType, documentId: string): Promise<void> {
    await this.col.deleteMany({ documentType, documentId } as never);
  }

 /**
 * Resolve a RAW token → its document ref, or null (miss/revoked/expired all →
 * null; the caller returns a uniform 404). Indexed hash lookup + constant-time
 * compare. Revoke/expire columns are honored defensively even though no
 * write path sets them yet.
 */
  async resolve(raw: string): Promise<{ documentType: ShareDocumentType; documentId: string } | null> {
    if (!raw) return null;
    const tokenHash = hashToken(raw);
    const row = await this.col.findOne({ tokenHash } as never, { projection: { _id: 0 } });
    if (!row) return null;
 // Defense-in-depth constant-time compare (the indexed lookup already matched
 // the full hash, but the timing-safe compare is mandated explicitly).
    if (!timingSafeHexEqual(row.tokenHash, tokenHash)) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt <= new Date().toISOString()) return null;
    return { documentType: row.documentType, documentId: row.documentId };
  }
}
