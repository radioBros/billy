import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Contract test for uploadFile — guards the frontend↔backend request-upload shape.
 * The original bug: uploadFile sent `{ filename, contentType, size }`, but the
 * server's RequestUploadSchema REQUIRES `{ ownerType, ownerId, filename,
 * contentType, sizeBytes }` — so every upload failed VALIDATION_FAILED
 * (ownerType/ownerId/sizeBytes "Required"). These assertions lock the body shape.
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

describe("uploadFile — request-upload contract", () => {
  beforeEach(() => {
    post.mockReset();
    // request-upload → ticket, then confirm → ok.
    post.mockImplementation(async (path: string) => {
      if (path.endsWith("/request-upload")) return { fileId: "f1", uploadUrl: "http://minio.test/put", headers: {} };
      return {};
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response));
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

  it("confirm carries sizeBytes (ConfirmUploadSchema requires it) and returns the fileId", async () => {
    const id = await uploadFile(makeFile("a.png", "image/png", 99));
    expect(id).toBe("f1");
    const confirm = post.mock.calls.find((c) => String(c[0]).endsWith("/confirm"));
    expect(confirm?.[1]).toMatchObject({ sizeBytes: 99, contentType: "image/png" });
  });

  it("falls back to application/octet-stream when the browser reports no type", async () => {
    await uploadFile(makeFile("x", "", 5));
    const body = post.mock.calls.find((c) => String(c[0]).endsWith("/request-upload"))?.[1] as Record<string, unknown>;
    expect(body.contentType).toBe("application/octet-stream");
  });
});
