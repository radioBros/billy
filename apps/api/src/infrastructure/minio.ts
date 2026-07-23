import { Client } from "minio";

/**
 * MinIO (S3-compatible) object storage connection.
 *
 * `ping()` checks reachability (readiness probe). `ensureBucket()` creates the
 * bucket if it does not exist and enforces a PRIVATE policy — this makes the app
 * self-provisioning so NO `minio-init` sidecar (or any manual `mc mb`) is ever
 * required for a fresh install. Every object is served via short-TTL presigned
 * URLs; the bucket must never be public.
 */
export interface MinioConn {
  client: Client;
  ping(): Promise<void>;
  /** Idempotently create `bucket` (private) if absent. Safe to call every boot. */
  ensureBucket(bucket: string): Promise<void>;
}

export const createMinio = (cfg: {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
}): MinioConn => {
  const client = new Client({
    endPoint: cfg.endPoint,
    port: cfg.port,
    useSSL: cfg.useSSL,
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
  });
  return {
    client,
    async ping() {
      // Reachability check — result value is irrelevant; a network/auth failure throws.
      await client.bucketExists(cfg.bucket);
    },
    async ensureBucket(bucket: string) {
      const exists = await client.bucketExists(bucket).catch(() => false);
      if (!exists) {
        // Region "" lets the server pick its default (works for standalone MinIO).
        await client.makeBucket(bucket, "");
      }
      // Explicitly deny anonymous access (private-only). Setting an empty policy
      // removes any public policy; MinIO buckets are private by default, so this
      // is belt-and-suspenders and idempotent.
      await client
        .setBucketPolicy(
          bucket,
          JSON.stringify({ Version: "2012-10-17", Statement: [] }),
        )
        .catch(() => {
          /* no public policy to clear on a fresh private bucket — ignore */
        });
    },
  };
};
