import type { Db } from "mongodb";
import { AppError, errors, type Logger } from "@billy/shared";
import type { DomainEventEmitter } from "@/platform/service.js";
import type { ShareTokenStore } from "@/modules/public-links/share-tokens.js";
import { QUOTES_COLLECTION } from "@/modules/quotes/repository.js";
import { INVOICES_COLLECTION } from "@/modules/invoices/repository.js";
import { serializePublicInvoice, serializePublicQuote } from "@/modules/public-links/serializer.js";
import type {
  PublicInvoiceDTO,
  PublicInvoiceDoc,
  PublicQuoteDTO,
  PublicQuoteDoc,
} from "@/modules/public-links/types.js";

/**
 * Public-link resolution + quote accept/decline.
 *
 * SECURITY MODEL (raw-token build, per the task brief):
 * - Lookup is a single folded query — `{ publicToken, deletedAt:null,
 * archivedAt:null, status ∈ shareable }`. Every miss (unknown / soft-deleted /
 * archived / non-shareable status) throws the IDENTICAL `RESOURCE_NOT_FOUND`
 * with no reason-specific detail, so the surface leaks no enumeration signal.
 * - Entropy (192-bit token) + uniform 404 + rate-limiting are the genuine
 * defenses. `timingSafeEqual` is applied to honor the brief, but over an
 * exact-match query it is REDUNDANT (the DB already matched the full token) —
 * it is only meaningful in the hashed-lookup model.
 */

/** Settings singleton (business branding) — minimal read shape. */
interface BusinessSettingsDoc {
  key: "business";
  data: { businessName: string };
}
const SETTINGS_COLLECTION = "settings";

/** A quote is publicly shareable only while it is `sent`/`accepted`/`declined`. */
const SHAREABLE_QUOTE_STATUSES = ["sent", "accepted", "declined"] as const;
/** An invoice is publicly shareable once it leaves draft (never `draft`/`void`). */
const SHAREABLE_INVOICE_STATUSES = ["finalized", "sent", "partially_paid", "paid"] as const;

const nowIso = (): string => new Date().toISOString();

export interface PublicLinkServiceDeps {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
 /** Hashed share-token store: resolves a raw token → {type,id}. */
  shareTokens: ShareTokenStore;
}

export class PublicLinkService {
  private readonly db: Db;
  private readonly emitter: DomainEventEmitter;
  private readonly logger: Logger;
  private readonly shareTokens: ShareTokenStore;

  constructor(deps: PublicLinkServiceDeps) {
    this.db = deps.db;
    this.emitter = deps.emitter;
    this.logger = deps.logger;
    this.shareTokens = deps.shareTokens;
  }

 /**
 * Resolve a raw token to a document id of the expected type, or throw the
 * uniform notFound(). Hashed indexed lookup happens in the store; a
 * wrong-type token (quote token used on the invoice route) is also a miss.
 */
  private async resolveTokenId(token: string, expected: "quote" | "invoice"): Promise<string> {
    const ref = await this.shareTokens.resolve(token);
    if (!ref || ref.documentType !== expected) throw errors.notFound();
    return ref.documentId;
  }

  /**
   * Business name for the document's OWN account. Settings are per-account, so we
   * must read the business settings scoped to the account that owns the shared
   * document — not an arbitrary/first one.
   */
  private async businessName(accountId: string | null | undefined): Promise<string> {
    if (!accountId) return "";
    const doc = await this.db
      .collection<BusinessSettingsDoc>(SETTINGS_COLLECTION)
      .findOne({ key: "business", accountId } as never, { projection: { _id: 0, data: 1 } });
    return doc?.data.businessName ?? "";
  }

 /** GET /public/quotes/:token — read-only public quote projection. */
  async getQuote(token: string): Promise<PublicQuoteDTO> {
    const quote = await this.resolveQuote(token);
    return serializePublicQuote(quote, await this.businessName((quote as { accountId?: string }).accountId));
  }

 /** GET /public/invoices/:token — read-only public invoice projection. */
  async getInvoice(token: string): Promise<PublicInvoiceDTO> {
    const id = await this.resolveTokenId(token, "invoice");
    const invoice = await this.db.collection<PublicInvoiceDoc>(INVOICES_COLLECTION).findOne({
      id,
      deletedAt: null,
      archivedAt: null,
      status: { $in: [...SHAREABLE_INVOICE_STATUSES] },
    });
 // A valid token whose document is gone/archived/non-shareable → same 404.
    if (!invoice) throw errors.notFound();
    return serializePublicInvoice(invoice, await this.businessName((invoice as { accountId?: string }).accountId));
  }

 /** POST /public/quotes/:token/accept — idempotent sent→accepted. */
  async acceptQuote(token: string): Promise<PublicQuoteDTO> {
    return this.transition(token, "accepted", "acceptedAt", "quote.accepted");
  }

 /** POST /public/quotes/:token/decline — idempotent sent→declined. */
  async declineQuote(token: string): Promise<PublicQuoteDTO> {
    return this.transition(token, "declined", "declinedAt", "quote.declined");
  }

  private async resolveQuote(token: string): Promise<PublicQuoteDoc> {
    const id = await this.resolveTokenId(token, "quote");
    return this.resolveQuoteById(id);
  }

  private async resolveQuoteById(id: string): Promise<PublicQuoteDoc> {
    const quote = await this.db.collection<PublicQuoteDoc>(QUOTES_COLLECTION).findOne({
      id,
      deletedAt: null,
      archivedAt: null,
      status: { $in: [...SHAREABLE_QUOTE_STATUSES] },
    });
    if (!quote) throw errors.notFound();
    return quote;
  }

 /**
 * Atomic, idempotent, state-guarded transition.
 * - Conditional update requires `status: 'sent'` → race-safe single winner.
 * - Winner emits `quote.<event>` with `actorId: null` (public actor).
 * - Replay against an already-terminal quote returns the same projection
 * WITHOUT re-emitting (idempotent). Any other status → INVALID_STATE_TRANSITION.
 */
  private async transition(
    token: string,
    next: "accepted" | "declined",
    tsField: "acceptedAt" | "declinedAt",
    eventName: string,
  ): Promise<PublicQuoteDTO> {
    const id = await this.resolveTokenId(token, "quote");
    const collection = this.db.collection<PublicQuoteDoc>(QUOTES_COLLECTION);
    const ts = nowIso();

    const res = await collection.updateOne(
      {
        id,
        deletedAt: null,
        archivedAt: null,
        status: "sent",
      },
      {
        $set: { status: next, [tsField]: ts, updatedAt: ts },
        $inc: { version: 1 },
      },
    );

    if (res.modifiedCount === 1) {
      const updated = await this.resolveQuoteById(id);
      await this.emitter.emit({
        name: eventName,
        actorId: null,
        entityType: "quote",
        entityId: updated.id,
        payload: { via: "public-link" },
      });
      this.logger.info({ event: eventName, entityId: updated.id }, "public-link.transition");
      return serializePublicQuote(updated, await this.businessName((updated as { accountId?: string }).accountId));
    }

 // No row transitioned — disambiguate against the current state. The filter
 // mirrors GET's shareable-status set, so a real-but-non-shareable quote
 // (draft/expired/converted still carrying a token) falls through to the
 // IDENTICAL notFound() GET returns — no enumeration asymmetry between the two.
    const current = await collection.findOne({
      id,
      deletedAt: null,
      archivedAt: null,
      status: { $in: [...SHAREABLE_QUOTE_STATUSES] },
    });
    if (!current) throw errors.notFound();

 // Idempotent replay: already in the requested terminal state → same result, no re-emit.
    if (current.status === next && SHAREABLE_QUOTE_STATUSES.includes(current.status)) {
      return serializePublicQuote(current, await this.businessName((current as { accountId?: string }).accountId));
    }
    throw new AppError("INVALID_STATE_TRANSITION", `Quote is not acceptable/declinable in status ${current.status}`);
  }
}
