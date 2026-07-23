import type { Server as HttpServer } from "node:http";
import { Server as IoServer, type Socket } from "socket.io";
import type { AuthContext } from "@billy/types";
import type { Logger } from "@billy/shared";
import type { SubscribableEmitter } from "@/modules/realtime/emitter.js";
import { authenticateHandshake, type SessionResolver } from "@/modules/realtime/handshake.js";
import { projectEvent, userRoom, WS_EVENT_CHANNEL } from "@/modules/realtime/projection.js";

export type { SubscribableEmitter, DomainEventListener } from "@/modules/realtime/emitter.js";
export { createSubscribableEmitter } from "@/modules/realtime/emitter.js";
export type { SessionResolver } from "@/modules/realtime/handshake.js";
export { authenticateHandshake, extractSessionToken } from "@/modules/realtime/handshake.js";
export {
  projectEvent,
  isProjectable,
  userRoom,
  WS_EVENT_CHANNEL,
  type WsEvent,
  type ProjectedEvent,
} from "@/modules/realtime/projection.js";

/** Per-socket state we attach after a successful handshake. */
interface SocketData {
  authContext: AuthContext;
}

type BillySocket = Socket<Record<string, never>, Record<string, never>, Record<string, never>, SocketData>;

/** The subset of app config the realtime layer needs. */
export interface RealtimeConfig {
  /** Browser app origin — CORS allow-list for the WS handshake (matches HTTP). */
  APP_URL: string;
}

export interface CreateRealtimeDeps {
  httpServer: HttpServer;
  /** The SAME subscribable emitter every service holds (index.ts wires it once). */
  emitter: SubscribableEmitter;
  /** Session resolver — the real `AuthService` satisfies this (cookie → AuthContext). */
  sessionResolver: SessionResolver;
  logger: Logger;
  config: RealtimeConfig;
}

export interface Realtime {
  /** The socket.io server (exposed for tests / future use). */
  io: IoServer;
  /** Detach the emitter listener and close all sockets (graceful shutdown, no leak). */
  close(): Promise<void>;
}

/** Socket.io path — kept explicit and consistent for the reverse proxy. */
export const REALTIME_PATH = "/socket.io";

export const createRealtime = (deps: CreateRealtimeDeps): Realtime => {
  const { httpServer, emitter, sessionResolver, logger, config } = deps;

  const io: IoServer = new IoServer(httpServer, {
    path: REALTIME_PATH,
    // `credentials: true` is what makes the browser send the HttpOnly session
    // cookie on the WS handshake. Origin is the app URL (never `*`), consistent
    // with the HTTP CORS policy (app.ts).
    cors: { origin: config.APP_URL, credentials: true },
  });

  // ── WS1: session-cookie handshake auth (reuse HTTP session resolution) ──────
  io.use((socket: BillySocket, next: (err?: Error) => void): void => {
    void (async (): Promise<void> => {
      try {
        const authContext = await authenticateHandshake(socket.handshake.headers.cookie, sessionResolver);
        if (!authContext) {
          logger.info({ sid: socket.id }, "realtime.handshake_rejected");
          next(new Error("UNAUTHENTICATED"));
          return;
        }
        socket.data.authContext = authContext;
        next();
      } catch (err) {
        logger.warn({ err, sid: socket.id }, "realtime.handshake_error");
        next(new Error("UNAUTHENTICATED"));
      }
    })();
  });

  // ── WS2: per-user room join (multi-device: many sockets share one room) ─────
  io.on("connection", (socket: BillySocket): void => {
    const { userId } = socket.data.authContext;
    void socket.join(userRoom(userId));
    logger.info({ sid: socket.id, userId }, "realtime.connected");

    socket.on("disconnect", (reason: string): void => {
      // socket.io auto-removes the socket from its rooms on disconnect, so room
      // membership cannot leak; nothing manual to clean up per-socket.
      logger.info({ sid: socket.id, userId, reason }, "realtime.disconnected");
    });
  });

  // ── WS3/WS4: subscribe to domain events; push scoped to the owner's room ────
  const unsubscribe = emitter.on((event): void => {
    const projected = projectEvent(event);
    // Fail-closed: unprojectable type OR unresolved recipient ⇒ drop, never
    // broadcast (the security-critical no-leak property).
    if (!projected) return;
    io.to(userRoom(projected.targetUserId)).emit(WS_EVENT_CHANNEL, projected.event);
    logger.info(
      { eventType: projected.event.eventType, targetUserId: projected.targetUserId },
      "realtime.pushed",
    );
  });

  return {
    io,
    async close(): Promise<void> {
      // Remove the emitter listener FIRST (no dangling subscription / leak),
      // then close the socket server (drops all sockets + rooms).
      unsubscribe();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
};
