import { z } from "zod";

/**
 * Canonical configuration registry for the whole stack.
 *
 * Single source of truth for every environment key, validated + coerced at boot
 * (fail-fast). Consumed by api/worker via the single bind-mounted `.env`.
 * Keys map 1:1 to `.env.example`.
 *
 * Secrets are required only in production; dev has safe defaults so the stack
 * boots out of the box.
 */

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const isProd = process.env.APP_ENV === "production";
const requiredInProd = <T extends z.ZodTypeAny>(schema: T, devDefault: string) =>
  isProd ? schema : schema.default(devDefault as never);

/**
 * An `.env` file (or `env_file:` in Compose) always supplies STRINGS, so an
 * unset-but-listed key like `BOOTSTRAP_ADMIN_EMAIL=` arrives as `""` — which
 * would fail `.email()`/`.min(1)` instead of being treated as absent. Wrap an
 * optional field so an empty/whitespace-only string is normalized to
 * `undefined` (i.e. "not set") BEFORE its validation runs. This makes commented
 * "leave blank to skip" keys behave as documented.
 */
const optionalEnv = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    schema.optional(),
  );

/**
 * Like `optionalEnv` but with a fallback: a blank/whitespace env value uses
 * `def` instead of failing the inner validation. For validated defaults
 * (`APP_URL`/`SMTP_FROM_EMAIL`…) where an operator might leave the key blank in
 * `.env` and expect the documented default, not a boot crash.
 */
const withDefault = <T extends z.ZodTypeAny>(schema: T, def: string) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    schema.default(def as never),
  );

const EnvSchema = z.object({
  // App
  APP_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_URL: withDefault(z.string().url(), "http://localhost:8080"),
  API_URL: withDefault(z.string().url(), "http://localhost:8080/api"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  // Auth secrets (real strength enforced in prod; dev defaults are obvious placeholders)
  SESSION_SECRET: requiredInProd(z.string().min(16), "dev-session-secret-change-me"),
  JWT_SECRET: requiredInProd(z.string().min(16), "dev-jwt-secret-change-me"),
  // At-rest field-encryption key (encrypts admin-set secrets like the SMTP
  // password. 32-byte key; loss = those fields unrecoverable.)
  DATA_ENCRYPTION_KEY: requiredInProd(z.string().min(32), "dev-data-encryption-key-change-me-please-0"),

  // Mongo
  MONGO_URI: z.string().default("mongodb://localhost:27017/billy"),

  // Redis
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // MinIO / object storage
  MINIO_ENDPOINT: z.string().default("localhost"),
  MINIO_PORT: z.coerce.number().int().positive().default(9000),
  MINIO_USE_SSL: bool.default("false"),
  MINIO_BUCKET: z.string().default("billy"),
  MINIO_ACCESS_KEY: requiredInProd(z.string().min(1), "billy-admin"),
  MINIO_SECRET_KEY: requiredInProd(z.string().min(1), "change-me-in-env"),

  // Observability
  METRICS_ENABLED: bool.default("true"),

  // SMTP / email (fallbacks; the Customization Panel can override these in the DB.
  // Unset SMTP_HOST → dev jsonTransport, no real send.)
  SMTP_HOST: optionalEnv(z.string()),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: bool.default("false"),
  SMTP_USERNAME: optionalEnv(z.string()),
  SMTP_PASSWORD: optionalEnv(z.string()),
  SMTP_FROM_EMAIL: withDefault(z.string().email(), "no-reply@billy.local"),
  SMTP_FROM_NAME: z.string().default("Billy"),

  // Web Push (VAPID). Public key → config.js (safe to expose); private key →
  // worker secret. BOTH blank → web push cleanly DISABLED (like unset SMTP).
  // Generate once with: node -e "console.log(require('web-push').generateVAPIDKeys())".
  VAPID_PUBLIC_KEY: optionalEnv(z.string()),
  VAPID_PRIVATE_KEY: optionalEnv(z.string()),
  // Geoapify geocoding API key (address autocomplete). Server-side only — the web
  // app calls the /api/v1/geo proxy, never Geoapify directly. Empty → feature off.
  GEOAPIFY_API_KEY: optionalEnv(z.string()),
  VAPID_SUBJECT: withDefault(z.string(), "mailto:admin@billy.local"),

  // First-run admin bootstrap (one-time, document rotating after boot).
  // Empty/blank in `.env` → treated as unset (create the admin via the first-run UI).
  BOOTSTRAP_ADMIN_EMAIL: optionalEnv(z.string().email()),
  BOOTSTRAP_ADMIN_PASSWORD: optionalEnv(z.string().min(1)),
});

export type Config = Readonly<z.infer<typeof EnvSchema>> & {
  readonly isProd: boolean;
  readonly isDev: boolean;
};

/**
 * Parse and validate `env` (defaults to `process.env`). On failure throws a
 * single error listing every offending key — the app must not boot misconfigured.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration — the app cannot boot:\n${issues}`);
  }
  const value = parsed.data;
  return Object.freeze({
    ...value,
    isProd: value.APP_ENV === "production",
    isDev: value.APP_ENV === "development",
  });
}
