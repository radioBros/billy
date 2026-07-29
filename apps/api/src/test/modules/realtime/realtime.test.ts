import { describe, it, expect, vi } from "vitest";
import type { AuthContext } from "@billy/types";
import type { DomainEvent } from "@/platform/service.js";
import { createSubscribableEmitter } from "@/modules/realtime/emitter.js";
import {
  authenticateHandshake,
  extractSessionToken,
  type SessionResolver,
} from "@/modules/realtime/handshake.js";
import { projectEvent, isProjectable, userRoom } from "@/modules/realtime/projection.js";
import { SESSION_COOKIE_NAME } from "@/modules/auth/session.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ctxFor = (userId: string): AuthContext => {
  return {
    userId,
    role: "member",
    capabilities: {
      canManageSettings: false,
      canManageUsers: false,
      canPermanentlyDelete: false,
      canViewFinancialTotals: false,
      canExportData: false,
    },
    accountId: "default",
  };
};

const mockResolver = (valid: Record<string, string>): SessionResolver => {
  return {
    resolve: async (token) => {
      if (!token) return null;
      const userId = valid[token];
      return userId ? { authContext: ctxFor(userId) } : null;
    },
  };
};

const notificationEvent = (overrides: Partial<DomainEvent> = {}): DomainEvent => {
  return {
    name: "notification.created",
    actorId: "u-actor",
    entityType: "notification",
    entityId: "n-1",
    payload: { userId: "u-alice", type: "invoice.paid" },
    ...overrides,
  };
};

// ── WS1: cookie extraction ──────────────────────────────────────────────────

describe("extractSessionToken", () => {
  it("extracts the billy_session token from a Cookie header", () => {
    const header = `other=1; ${SESSION_COOKIE_NAME}=abc123; foo=bar`;
    expect(extractSessionToken(header)).toBe("abc123");
  });

  it("URL-decodes the token value", () => {
    const header = `${SESSION_COOKIE_NAME}=a%2Bb%3Dc`;
    expect(extractSessionToken(header)).toBe("a+b=c");
  });

  it("returns undefined when the session cookie is absent", () => {
    expect(extractSessionToken("foo=bar; baz=qux")).toBeUndefined();
  });

  it("returns undefined for a missing/empty header", () => {
    expect(extractSessionToken(undefined)).toBeUndefined();
    expect(extractSessionToken("")).toBeUndefined();
  });
});

// ── WS1: handshake authentication (reuses HTTP session resolver) ────────────

describe("authenticateHandshake", () => {
  const resolver = mockResolver({ "tok-alice": "u-alice" });

  it("resolves a valid session cookie to its AuthContext (same path as requireAuth)", async () => {
    const ctx = await authenticateHandshake(`${SESSION_COOKIE_NAME}=tok-alice`, resolver);
    expect(ctx).not.toBeNull();
    expect(ctx?.userId).toBe("u-alice");
  });

  it("rejects (null) when no session cookie is present", async () => {
    expect(await authenticateHandshake("foo=bar", resolver)).toBeNull();
    expect(await authenticateHandshake(undefined, resolver)).toBeNull();
  });

  it("rejects (null) an invalid/expired/revoked session (resolver returns null)", async () => {
    expect(await authenticateHandshake(`${SESSION_COOKIE_NAME}=nope`, resolver)).toBeNull();
  });

  it("does not resolve without a token (no bespoke token scheme)", async () => {
    const spy = vi.fn(async () => null);
    await authenticateHandshake("unrelated=x", { resolve: spy });
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── WS3: projection + WS4: per-user room targeting / fail-closed authz ──────

describe("projectEvent", () => {
  it("projects notification.created to the recipient (payload.userId) only", () => {
    const projected = projectEvent(notificationEvent({ payload: { userId: "u-bob" } }));
    expect(projected).not.toBeNull();
    expect(projected?.targetUserId).toBe("u-bob");
    expect(userRoom(projected!.targetUserId)).toBe("user:u-bob");
    expect(projected?.event.eventType).toBe("notification.created");
    expect(projected?.event.entityId).toBe("n-1");
    // minimal-payload envelope has the required contract fields
    expect(projected?.event.eventId).toBeTypeOf("string");
    expect(projected?.event.timestamp).toBeTypeOf("string");
  });

  it("projects notification.updated as well", () => {
    const projected = projectEvent(notificationEvent({ name: "notification.updated" }));
    expect(projected?.event.eventType).toBe("notification.updated");
    expect(projected?.targetUserId).toBe("u-alice");
  });

  it("DROPS (fail-closed) an event whose recipient cannot be resolved — never broadcast", () => {
    expect(projectEvent(notificationEvent({ payload: {} }))).toBeNull();
    expect(projectEvent(notificationEvent({ payload: { userId: "" } }))).toBeNull();
    expect(projectEvent(notificationEvent({ payload: { userId: 123 } }))).toBeNull();
    expect(projectEvent(notificationEvent({ payload: undefined }))).toBeNull();
  });

  it("DROPS domain events outside the WS subset (e.g. invoice.paid, auth.login)", () => {
    expect(isProjectable("invoice.paid")).toBe(false);
    expect(projectEvent(notificationEvent({ name: "invoice.paid" }))).toBeNull();
    expect(projectEvent(notificationEvent({ name: "auth.login" }))).toBeNull();
  });

  it("does NOT route to a different user than the payload recipient (no cross-user leak)", () => {
    const projected = projectEvent(
      notificationEvent({ actorId: "u-alice", payload: { userId: "u-bob" } }),
    );
    // actor (Alice) triggered it, but it must target the OWNER (Bob) only.
    expect(projected?.targetUserId).toBe("u-bob");
    expect(projected?.targetUserId).not.toBe("u-alice");
  });
});

// ── Emitter bridge: subscription + fan-out + cleanup ────────────────────────

describe("createSubscribableEmitter", () => {
  it("forwards emit to the wrapped emitter AND notifies subscribers", async () => {
    const inner = { emit: vi.fn() };
    const bridge = createSubscribableEmitter(inner);
    const seen: DomainEvent[] = [];
    bridge.on((e) => seen.push(e));

    const ev = notificationEvent();
    await bridge.emit(ev);

    expect(inner.emit).toHaveBeenCalledWith(ev);
    expect(seen).toEqual([ev]);
  });

  it("unsubscribe removes the listener (no leak on close)", async () => {
    const bridge = createSubscribableEmitter({ emit: vi.fn() });
    const seen: DomainEvent[] = [];
    const off = bridge.on((e) => seen.push(e));

    await bridge.emit(notificationEvent());
    off();
    await bridge.emit(notificationEvent());

    expect(seen).toHaveLength(1);
  });

  it("a throwing listener does not break emission for others or the caller", async () => {
    const bridge = createSubscribableEmitter({ emit: vi.fn() });
    const seen: string[] = [];
    bridge.on(() => {
      throw new Error("boom");
    });
    bridge.on(() => seen.push("ok"));

    await expect(bridge.emit(notificationEvent())).resolves.toBeUndefined();
    expect(seen).toEqual(["ok"]);
  });

  it("end-to-end (mocked): a notification.created emit routes to the owner's room only", async () => {
    // Simulate what createRealtime wires: subscribe, project, and record the
    // targeted room instead of touching a real socket.io server.
    const bridge = createSubscribableEmitter({ emit: vi.fn() });
    const pushes: Array<{ room: string; type: string }> = [];
    bridge.on((event) => {
      const projected = projectEvent(event);
      if (!projected) return;
      pushes.push({ room: userRoom(projected.targetUserId), type: projected.event.eventType });
    });

    await bridge.emit(notificationEvent({ payload: { userId: "u-alice" } }));
    await bridge.emit(notificationEvent({ payload: { userId: "u-bob" }, name: "notification.updated" }));
    await bridge.emit(notificationEvent({ name: "invoice.paid" })); // not projected
    await bridge.emit(notificationEvent({ payload: {} })); // unresolved → dropped

    expect(pushes).toEqual([
      { room: "user:u-alice", type: "notification.created" },
      { room: "user:u-bob", type: "notification.updated" },
    ]);
  });
});
