import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useAuthStore } from "@/stores/auth";

const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth store — login flow", () => {
  it("logs in, stores the principal and flips isAuthenticated", async () => {
    const principal = {
      status: "authenticated",
      userId: "u1",
      role: "administrator",
      capabilities: {},
      accountId: "biz1",
      displayName: "Ada",
    };
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: principal, meta: {}, error: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const auth = useAuthStore();
    expect(auth.isAuthenticated).toBe(false);

    const result = await auth.login({ email: "ada@x.test", password: "pw" });

    expect(result.status).toBe("authenticated");
    expect(auth.principal?.userId).toBe("u1");
    expect(auth.isAuthenticated).toBe(true);

    // Called the login endpoint with credentials included and the body.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/v1/auth/login");
    expect(init.credentials).toBe("include");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ email: "ada@x.test", password: "pw" });
  });

  it("propagates ApiError on invalid credentials and stays unauthenticated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { data: null, meta: {}, error: { code: "INVALID_CREDENTIALS", message: "bad" } },
          401,
        ),
      ),
    );
    const auth = useAuthStore();
    await expect(auth.login({ email: "x@x.test", password: "wrong" })).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect(auth.isAuthenticated).toBe(false);
  });

  it("fetchMe swallows a 401 into principal=null and resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { data: null, meta: {}, error: { code: "UNAUTHENTICATED", message: "no session" } },
          401,
        ),
      ),
    );
    const auth = useAuthStore();
    const me = await auth.fetchMe();
    expect(me).toBeNull();
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.resolving).toBe(false);
  });

  it("returns the 2fa_required challenge WITHOUT setting a principal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: { status: "2fa_required", pendingToken: "pt-123", expiresInMs: 120000 },
          meta: {},
          error: null,
        }),
      ),
    );
    const auth = useAuthStore();
    const result = await auth.login({ email: "ada@x.test", password: "pw" });
    expect(result.status).toBe("2fa_required");
    if (result.status === "2fa_required") expect(result.pendingToken).toBe("pt-123");
    // No cookie/principal yet — the challenge is not authenticated.
    expect(auth.isAuthenticated).toBe(false);
  });

  it("verifyTwoFactor exchanges the pending token for an authenticated principal", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: {
          status: "authenticated",
          userId: "u9",
          role: "member",
          capabilities: {},
          accountId: "b",
          amrTwoFactor: true,
        },
        meta: {},
        error: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const auth = useAuthStore();
    const p = await auth.verifyTwoFactor("pt-123", "123456");
    expect(p.userId).toBe("u9");
    expect(auth.isAuthenticated).toBe(true);
    // Principal carries no `status` discriminator, and posts to the verify route.
    expect((auth.principal as unknown as { status?: string }).status).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/v1/auth/login/verify-2fa");
    expect(JSON.parse(init.body as string)).toEqual({ pendingToken: "pt-123", code: "123456" });
  });

  it("logout clears the principal", async () => {
    const auth = useAuthStore();
    // seed authenticated state via a login first
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            data: { status: "authenticated", userId: "u1", role: "member", capabilities: {}, accountId: "b" },
            meta: {},
            error: null,
          },
          200,
        ),
      ),
    );
    await auth.login({ email: "a@a.test", password: "p" });
    expect(auth.isAuthenticated).toBe(true);

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: null, meta: {}, error: null })));
    await auth.logout();
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.principal).toBeNull();
  });
});
