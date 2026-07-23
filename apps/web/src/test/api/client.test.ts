import { describe, it, expect, vi, afterEach } from "vitest";
import { api, ApiError, get } from "@/api/client";

const mockFetch = (body: unknown, status = 200): void => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(text, {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client — envelope handling", () => {
  it("unwraps a success envelope to data", async () => {
    mockFetch({ data: { id: "c1", displayName: "Acme" }, meta: {}, error: null });
    const result = await get<{ id: string; displayName: string }>("/v1/clients/c1");
    expect(result).toEqual({ id: "c1", displayName: "Acme" });
  });

  it("throws ApiError carrying error.code on an error envelope", async () => {
    mockFetch(
      { data: null, meta: {}, error: { code: "RESOURCE_NOT_FOUND", message: "nope" } },
      404,
    );
    await expect(get("/v1/clients/missing")).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      status: 404,
    });
    // And it is specifically an ApiError.
    mockFetch(
      { data: null, meta: {}, error: { code: "INVALID_CREDENTIALS", message: "bad" } },
      401,
    );
    const err = await get("/v1/auth/me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("INVALID_CREDENTIALS");
  });

  it("list() returns both data and meta", async () => {
    mockFetch({
      data: [{ id: "c1" }, { id: "c2" }],
      meta: { page: 1, limit: 50, total: 2, pageCount: 1, sort: [] },
      error: null,
    });
    const result = await api.list<{ id: string }>("/v1/clients", { page: 1, limit: 50 });
    expect(result.data).toHaveLength(2);
    expect(result.meta.total).toBe(2);
  });

  it("throws ApiError with a synthesized code on a non-envelope error body", async () => {
    mockFetch("<html>500</html>", 500);
    const err = await get("/v1/clients").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("INTERNAL_ERROR");
  });

  it("throws ApiError on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const err = await get("/v1/clients").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("DEPENDENCY_UNAVAILABLE");
  });

  it("targets the runtime-config API_URL, not a build-time constant", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: {}, meta: {}, error: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    window.__APP_CONFIG__ = { API_URL: "http://other.test/api" } as never;
    await get("/v1/clients");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://other.test/api/v1/clients",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});
