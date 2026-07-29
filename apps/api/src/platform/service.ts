import { type AuthContext, type BaseDoc, type Capabilities } from "@billy/types";
import { AppError, type Logger } from "@billy/shared";
import type { BaseRepository } from "@/platform/repository.js";

export const assertCapability = (ctx: AuthContext, cap: keyof Capabilities): void => {
  if (ctx.role === "administrator") return;
  if (!ctx.capabilities[cap]) {
    throw new AppError("CAPABILITY_DENIED", `Missing capability: ${cap}`);
  }
};

export const assertTransition = <S extends string>(current: S, next: S, allowed: Partial<Record<S, readonly S[]>>): void => {
  const oks = allowed[current] ?? [];
  if (!oks.includes(next)) {
    throw new AppError("INVALID_STATE_TRANSITION", `Illegal transition: ${current} → ${next}`);
  }
};

/**
 * Domain-event emission contract. The auth/notifications
 * systems provide the real implementation (persistence + delivery); the default
 * logs, so services can emit before those land.
 */
export interface DomainEvent {
  name: string;
  actorId: string | null;
  entityType: string;
  entityId: string;
  payload?: Record<string, unknown>;
}

export interface DomainEventEmitter {
  emit(event: DomainEvent): void | Promise<void>;
}

export const createLoggingEmitter = (logger: Logger): DomainEventEmitter => {
  return {
    emit(event) {
      logger.info({ event: event.name, entityType: event.entityType, entityId: event.entityId }, "domain.event");
    },
  };
};

export interface ServiceDeps<T extends BaseDoc> {
  repo: BaseRepository<T>;
  emitter: DomainEventEmitter;
  logger: Logger;
}

/** Base service the domain modules extend. Holds shared deps + exposes the guards. */
export abstract class BaseService<T extends BaseDoc> {
  protected readonly repo: BaseRepository<T>;
  protected readonly emitter: DomainEventEmitter;
  protected readonly logger: Logger;

  constructor(deps: ServiceDeps<T>) {
    this.repo = deps.repo;
    this.emitter = deps.emitter;
    this.logger = deps.logger;
  }

  protected requireCapability(ctx: AuthContext, cap: keyof Capabilities): void {
    assertCapability(ctx, cap);
  }

  protected async emit(event: DomainEvent): Promise<void> {
    await this.emitter.emit(event);
  }

  /**
   * Transaction boundary hook. Multi-document ACID wiring is not yet in place;
   * until it lands this runs the unit directly so single-document module flows work.
   */
  protected async withTransaction<R>(fn: () => Promise<R>): Promise<R> {
    return fn();
  }
}
