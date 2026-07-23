import { describe, it, expect } from "vitest";
import { loadConfig } from "../index.js";

/**
 * Config loader tests. The headline case is the cold-start regression: an `.env`
 * file (or Compose `env_file:`) supplies STRINGS, so a listed-but-blank optional
 * key arrives as `""` — which must be treated as unset, not as an invalid value.
 * A prior build crashed the API at boot on `BOOTSTRAP_ADMIN_EMAIL=` for exactly
 * this reason.
 */

const BASE: NodeJS.ProcessEnv = {
  APP_ENV: "development",
};

describe("loadConfig — empty optional env values are treated as unset", () => {
  it("blank BOOTSTRAP_ADMIN_* does NOT fail validation (regression)", () => {
    const cfg = loadConfig({ ...BASE, BOOTSTRAP_ADMIN_EMAIL: "", BOOTSTRAP_ADMIN_PASSWORD: "" });
    expect(cfg.BOOTSTRAP_ADMIN_EMAIL).toBeUndefined();
    expect(cfg.BOOTSTRAP_ADMIN_PASSWORD).toBeUndefined();
  });

  it("blank SMTP_* are treated as unset (→ dev jsonTransport)", () => {
    const cfg = loadConfig({ ...BASE, SMTP_HOST: "", SMTP_USERNAME: "  ", SMTP_PASSWORD: "" });
    expect(cfg.SMTP_HOST).toBeUndefined();
    expect(cfg.SMTP_USERNAME).toBeUndefined();
    expect(cfg.SMTP_PASSWORD).toBeUndefined();
  });

  it("a real BOOTSTRAP_ADMIN_EMAIL still validates + passes through", () => {
    const cfg = loadConfig({ ...BASE, BOOTSTRAP_ADMIN_EMAIL: "admin@billy.local", BOOTSTRAP_ADMIN_PASSWORD: "pw" });
    expect(cfg.BOOTSTRAP_ADMIN_EMAIL).toBe("admin@billy.local");
    expect(cfg.BOOTSTRAP_ADMIN_PASSWORD).toBe("pw");
  });

  it("a non-empty but INVALID email still fails fast", () => {
    expect(() => loadConfig({ ...BASE, BOOTSTRAP_ADMIN_EMAIL: "not-an-email" })).toThrow(/cannot boot/u);
  });

  it("blank validated-DEFAULT fields fall back to the default (not a crash)", () => {
    const cfg = loadConfig({ ...BASE, APP_URL: "", API_URL: "  ", SMTP_FROM_EMAIL: "" });
    expect(cfg.APP_URL).toBe("http://localhost:8080");
    expect(cfg.API_URL).toBe("http://localhost:8080/api");
    expect(cfg.SMTP_FROM_EMAIL).toBe("no-reply@billy.local");
  });
});

describe("loadConfig — core behavior", () => {
  it("applies dev defaults out of the box", () => {
    const cfg = loadConfig(BASE);
    expect(cfg.isDev).toBe(true);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.MONGO_URI).toContain("mongodb://");
  });

  it("coerces PORT + booleans from strings", () => {
    const cfg = loadConfig({ ...BASE, PORT: "8081", MINIO_USE_SSL: "true", METRICS_ENABLED: "false" });
    expect(cfg.PORT).toBe(8081);
    expect(cfg.MINIO_USE_SSL).toBe(true);
    expect(cfg.METRICS_ENABLED).toBe(false);
  });
});
