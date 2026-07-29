import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Contract test for uploadFile — guards the frontend↔backend upload flow.
 *
 * Two invariants:
 *  1. request-upload body shape: the server's RequestUploadSchema REQUIRES
 *     `{ ownerType, ownerId, filename, contentType, sizeBytes }` (the original bug
 *     sent `size`, failing VALIDATION_FAILED).
 *  2. The bytes go SAME-ORIGIN to our own API (`<apiBaseUrl>/v1/files/:id/content`),
 *     NOT to a presigned MinIO URL — a presigned URL is signed for the internal
 *     Docker host (`minio:9000`), unreachable from a real browser in prod, which is
 *     what silently broke the logo upload. There is no separate `/confirm` call.
 */

const post = vi.fn<(path: string, body?: unknown) => Promise<unknown>>();
vi.mock("@/api/client", () => ({ api: { post: (p: string, b?: unknown) => post(p, b) } }));
vi.mock("@/config", () => ({ apiBaseUrl: () => "http://api.test/api" }));

import { uploadFile } from "@/api/files";

const makeFile = (name = "logo.svg", type = "image/svg+xml", size = 1234): File => {
  const f = new File(["<svg/>"], name, { type });
  // jsdom File.size is derived from content; force a deterministic size for the assertion.
  Object.defineProperty(f, "size", { value: size });
  return f;
};

let fetchMock: ReturnType<typeof vi.fn>;

describe("uploadFile — request-upload contract", () => {
  beforeEach(() => {
    post.mockReset();
    // request-upload → the REAL server shape: the created FileObject under `file`
    // (id at `file.id`, NOT a top-level `fileId`) plus objectKey. This mirrors
    // respondCreated({ file, objectKey }) — the mismatch that produced
    // `/files/undefined/content` in prod.
    post.mockImplementation(async (path: string) => {
      if (path.endsWith("/request-upload")) {
        return { file: { id: "f1", scanStatus: "pending", objectKey: "default/branding/branding/uuid" }, objectKey: "default/branding/branding/uuid" };
      }
      return {};
    });
    fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends ownerType, ownerId, filename, contentType and sizeBytes (the schema-required fields)", async () => {
    await uploadFile(makeFile("logo.svg", "image/svg+xml", 4096));
    const body = post.mock.calls.find((c) => String(c[0]).endsWith("/request-upload"))?.[1] as Record<string, unknown>;
    expect(body).toBeDefined();
    expect(body).toMatchObject({
      ownerType: "branding",
      ownerId: "branding",
      filename: "logo.svg",
      contentType: "image/svg+xml",
      sizeBytes: 4096,
    });
    // The old buggy key must NOT be present.
    expect(body).not.toHaveProperty("size");
  });

  it("honors an explicit owner", async () => {
    await uploadFile(makeFile("r.png", "image/png", 10), { ownerType: "expense", ownerId: "exp1" });
    const body = post.mock.calls.find((c) => String(c[0]).endsWith("/request-upload"))?.[1] as Record<string, unknown>;
    expect(body).toMatchObject({ ownerType: "expense", ownerId: "exp1" });
  });

  it("PUTs the bytes SAME-ORIGIN to /v1/files/:id/content (not a presigned MinIO URL) and returns the fileId — no separate confirm", async () => {
    const id = await uploadFile(makeFile("a.png", "image/png", 99));
    expect(id).toBe("f1");
    // No /confirm POST in the new flow.
    expect(post.mock.calls.some((c) => String(c[0]).endsWith("/confirm"))).toBe(false);
    // Bytes PUT to our own API origin, carrying the file and the auth cookie.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/api/v1/files/f1/content");
    expect(url).not.toContain("minio"); // never the presigned internal-host URL
    expect(init.method).toBe("PUT");
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("image/png");
  });

  it("falls back to application/octet-stream when the browser reports no type", async () => {
    await uploadFile(makeFile("x", "", 5));
    const body = post.mock.calls.find((c) => String(c[0]).endsWith("/request-upload"))?.[1] as Record<string, unknown>;
    expect(body.contentType).toBe("application/octet-stream");
  });
});
