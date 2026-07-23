import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// A minimal fake socket capturing handlers + lifecycle calls. Declared before the
// mock factory so the hoisted `vi.mock` can reference it via the closure.
interface FakeSocket {
  handlers: Record<string, (arg: unknown) => void>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

const state: { socket: FakeSocket | null; ioCalls: unknown[][] } = { socket: null, ioCalls: [] };

vi.mock("socket.io-client", () => ({
  io: (...args: unknown[]) => {
    state.ioCalls.push(args);
    const handlers: FakeSocket["handlers"] = {};
    const s: FakeSocket = {
      handlers,
      on: vi.fn((event: string, cb: (arg: unknown) => void) => {
        handlers[event] = cb;
        return s;
      }),
      off: vi.fn(() => s),
      disconnect: vi.fn(() => s),
    };
    state.socket = s;
    return s;
  },
}));

// The store seeds notifications on connect; stub fetch so that never throws.
const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

import { useRealtimeStore } from "@/stores/realtime";
import { realtimeUrl } from "@/stores/realtime";
import { useNotificationsStore } from "@/stores/notifications";

beforeEach(() => {
  setActivePinia(createPinia());
  state.socket = null;
  state.ioCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse({ data: [], meta: { total: 0 }, error: null })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("realtimeUrl", () => {
  it("returns the origin for an absolute API_URL", () => {
    expect(realtimeUrl("http://localhost:3000/api")).toBe("http://localhost:3000");
  });
  it("returns undefined (same-origin) for a relative API_URL", () => {
    expect(realtimeUrl("/api")).toBeUndefined();
  });
});

describe("realtime store — connect/disconnect lifecycle", () => {
  it("connect() opens one socket with the right path + credentials", () => {
    const store = useRealtimeStore();
    store.connect();

    expect(state.ioCalls).toHaveLength(1);
    expect(state.socket).not.toBeNull();
    // The first io() arg is the origin (from the test-setup API_URL http://api.test/api).
    expect(state.ioCalls[0]?.[0]).toBe("http://api.test");
    const opts = state.ioCalls[0]?.[1] as { path?: string; withCredentials?: boolean };
    expect(opts.path).toBe("/socket.io");
    expect(opts.withCredentials).toBe(true);
    expect(store.isOpen()).toBe(true);
  });

  it("connect() is idempotent (singleton guard)", () => {
    const store = useRealtimeStore();
    store.connect();
    store.connect();
    expect(state.ioCalls).toHaveLength(1);
  });

  it("forwards a WS 'event' to the notifications store ingest", () => {
    const store = useRealtimeStore();
    const notifications = useNotificationsStore();
    const ingest = vi.spyOn(notifications, "ingest");
    store.connect();

    const handler = state.socket?.handlers["event"];
    expect(handler).toBeTypeOf("function");
    const evt = {
      eventId: "e1",
      eventType: "notification.created",
      entityType: "notification",
      entityId: "n1",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: {},
    };
    handler?.(evt);
    expect(ingest).toHaveBeenCalledWith(evt);
  });

  it("disconnect() closes the socket and clears notifications", () => {
    const store = useRealtimeStore();
    const notifications = useNotificationsStore();
    const clear = vi.spyOn(notifications, "clear");
    store.connect();
    const sock = state.socket;

    store.disconnect();

    expect(sock?.disconnect).toHaveBeenCalled();
    expect(store.isOpen()).toBe(false);
    expect(clear).toHaveBeenCalled();
    // A fresh connect after disconnect opens a new socket.
    store.connect();
    expect(state.ioCalls).toHaveLength(2);
  });
});
