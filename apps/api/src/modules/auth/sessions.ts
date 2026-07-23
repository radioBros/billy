import type { Collection } from "mongodb";

/**
 * `sessions` collection + its pre-auth store. Resolving a
 * session is what PRODUCES an authContext, so this store also runs below the
 * authContext layer and queries the collection directly.
 */
export type RevokedReason =
  | "logout"
  | "user_revoked"
  | "admin_revoked"
  | "password_change"
  | "privilege_change"
  | "rotation"
  | "expired";

export interface Session {
  id: string;
  sessionTokenHash: string; // SHA-256 of the opaque cookie token — raw token never stored
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  rotatedFrom?: string | null;
  revokedAt?: string | null;
  revokedReason?: RevokedReason | null;
  ipAddress: string;
  userAgent: string;
  deviceLabel?: string | null;
  amrTwoFactor: boolean;
  /**
   * The account a SYSADMIN has currently assumed for this session. Ignored for
   * normal users (they are always scoped to their own user.accountId). Lets a
   * sysadmin switch which account they operate within without re-login.
   */
  activeAccountId?: string | null;
}

export interface SessionStore {
  create(session: Session): Promise<void>;
  findByTokenHash(hash: string): Promise<Session | null>;
  updateIdle(id: string, idleExpiresAt: string, lastSeenAt: string): Promise<void>;
  /** Patch arbitrary session fields (e.g. the sysadmin's activeAccountId). */
  update(id: string, patch: Partial<Session>): Promise<void>;
  revoke(id: string, reason: RevokedReason): Promise<void>;
  revokeAllForUser(userId: string, reason: RevokedReason): Promise<void>;
}

export class MongoSessionStore implements SessionStore {
  constructor(private readonly col: Collection<Session>) {}
  async create(session: Session): Promise<void> {
    await this.col.insertOne(session as never);
  }
  async findByTokenHash(hash: string): Promise<Session | null> {
    return (await this.col.findOne({ sessionTokenHash: hash }, { projection: { _id: 0 } })) as Session | null;
  }
  async updateIdle(id: string, idleExpiresAt: string, lastSeenAt: string): Promise<void> {
    await this.col.updateOne({ id }, { $set: { idleExpiresAt, lastSeenAt } } as never);
  }
  async update(id: string, patch: Partial<Session>): Promise<void> {
    await this.col.updateOne({ id }, { $set: patch } as never);
  }
  async revoke(id: string, reason: RevokedReason): Promise<void> {
    await this.col.updateOne({ id }, { $set: { revokedAt: new Date().toISOString(), revokedReason: reason } } as never);
  }
  async revokeAllForUser(userId: string, reason: RevokedReason): Promise<void> {
    await this.col.updateMany(
      { userId, revokedAt: null },
      { $set: { revokedAt: new Date().toISOString(), revokedReason: reason } } as never,
    );
  }
}
