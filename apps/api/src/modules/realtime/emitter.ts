import type { DomainEvent, DomainEventEmitter } from "@/platform/service.js";

/**
 * A {@link DomainEventEmitter} that also lets in-process consumers subscribe to
 * the events flowing through it.
 *
 * The platform's base {@link DomainEventEmitter} contract is emit-only; the
 * realtime layer needs to *observe* the same stream so it can project domain
 * events onto the WebSocket transport. Rather than editing the platform emitter
 * (out of scope for this module), we wrap the underlying emitter: `emit` is
 * forwarded to the wrapped emitter first (preserving existing behaviour —
 * logging, future persistence), then fanned out to every registered listener.
 *
 * Wiring this at construction (index.ts) means every downstream holder of the
 * emitter (auth service, services) shares the SAME subscribable instance, so
 * events they emit are visible here — without any of them knowing about it.
 */
export interface SubscribableEmitter extends DomainEventEmitter {
  /** Register a listener; returns an unsubscribe fn (used on socket-server close). */
  on(listener: DomainEventListener): () => void;
}

export type DomainEventListener = (event: DomainEvent) => void;

export const createSubscribableEmitter = (inner: DomainEventEmitter): SubscribableEmitter => {
  const listeners = new Set<DomainEventListener>();

  return {
    async emit(event: DomainEvent): Promise<void> {
      // Preserve the wrapped emitter's behaviour (e.g. logging) first.
      await inner.emit(event);
      // Fan out to observers. A throwing listener must not break emission for
      // the others nor for the caller.
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // swallow — a broken observer never affects domain-event emission.
        }
      }
    },
    on(listener: DomainEventListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
