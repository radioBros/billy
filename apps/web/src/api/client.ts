/**
 * API client — thin fetch wrapper over the canonical response envelope
 * and the list query grammar.
 *
 * Contract:
 *  - Base URL comes from runtime config (`getConfig().API_URL`), never build-time env.
 *  - `credentials: "include"` — cookie session auth.
 *  - Success envelopes are unwrapped: get/post/patch/del return `data` (T);
 *    `list()` returns `{ data, meta }` because tables bind `meta.total`.
 *  - Any failure throws `ApiError` carrying the envelope `error.code` (ErrorCode).
 *    Non-envelope failures (network error, non-JSON body, empty 5xx) also throw
 *    `ApiError` with a sensible fallback code rather than a raw JSON/parse error.
 *  - On 401 we throw UNAUTHENTICATED and let the router guard redirect; the shell
 *    does not implement refresh-retry (out of scope).
 */
import type {
  ApiErrorBody,
  Envelope,
  ErrorCode,
  ErrorDetails,
  ListMeta,
} from "@billy/types";
import { apiBaseUrl } from "@/config";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetails;

  constructor(code: ErrorCode, message: string, status: number, details?: ErrorDetails) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Global session-expiry hook. When any request comes back UNAUTHENTICATED (401 /
 * an expired-or-missing session), the registered handler runs so the app can log
 * out + redirect to /login instead of surfacing a raw "UNAUTHENTICATED" error on
 * whatever page triggered it. Registered once from main.ts (needs pinia+router,
 * which the client itself must not import). Auth calls opt out (see below) so
 * login/logout/me don't recurse. Fires at most once per "storm" of parallel 401s.
 */
type UnauthedHandler = () => void;
let unauthedHandler: UnauthedHandler | null = null;
let handlingUnauthed = false;

export const onUnauthenticated = (handler: UnauthedHandler): void => {
  unauthedHandler = handler;
};

/** Paths that must NOT trigger the auto-logout (they own the session lifecycle). */
const AUTH_LIFECYCLE = /\/auth\/(login|logout|me)$/u;

const fireUnauthenticated = (path: string): void => {
  if (AUTH_LIFECYCLE.test(path)) return; // login/logout/me handle 401 themselves
  if (handlingUnauthed || !unauthedHandler) return;
  handlingUnauthed = true;
  try {
    unauthedHandler();
  } finally {
    // Release on the next tick so a burst of parallel 401s collapses to one logout.
    setTimeout(() => {
      handlingUnauthed = false;
    }, 0);
  }
};

export type QueryValue = string | number | boolean | undefined | null;
export type QueryParams = Record<string, QueryValue>;

/** List query grammar params. Extra keys become filters. */
export interface ListQuery extends QueryParams {
  page?: number;
  limit?: number;
  /** Comma list; `-` prefix = desc, e.g. "-dueDate,invoiceNumber". */
  sort?: string;
  /** Free-text search across the resource's searchable fields. */
  q?: string;
  archived?: "false" | "true" | "all";
}

export interface ListResult<T> {
  data: T[];
  meta: ListMeta;
}

interface RequestOptions {
  query?: QueryParams;
  body?: unknown;
  signal?: AbortSignal;
  /** Optimistic-concurrency version → `If-Match` header. */
  ifMatch?: number;
}

const buildUrl = (path: string, query?: QueryParams): string => {
  const base = apiBaseUrl().replace(/\/$/, "");
  const rel = path.startsWith("/") ? path : `/${path}`;
  const url = `${base}${rel}`;
  if (!query) return url;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    qs.append(key, String(value));
  }
  const s = qs.toString();
  return s ? `${url}?${s}` : url;
};

function isEnvelope(value: unknown): value is Envelope<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    "error" in value
  );
}

const request = async <T>(method: string, path: string, opts: RequestOptions = {}): Promise<{ data: T; meta: ListMeta | Record<string, unknown> }> => {
  const headers: Record<string, string> = { Accept: "application/json" };
  let bodyInit: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyInit = JSON.stringify(opts.body);
  }
  // Optimistic-concurrency guard: routes read the expected version from `If-Match`
  // (preferred) or a body `version` field. We send the header so it works even for
  // update schemas that reject an unknown body `version` (e.g. subscriptions is
  // `.strict()`), while body-version routes still accept it.
  if (opts.ifMatch !== undefined) {
    headers["If-Match"] = String(opts.ifMatch);
  }

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body: bodyInit,
      credentials: "include",
      signal: opts.signal,
    });
  } catch (cause) {
    // Network failure / CORS / aborted: no envelope to read.
    const message = cause instanceof Error ? cause.message : "Network request failed";
    throw new ApiError("DEPENDENCY_UNAVAILABLE", message, 0);
  }

  // 204 No Content or empty body.
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (isEnvelope(parsed)) {
    if (parsed.error) {
      const err = parsed.error as ApiErrorBody;
      if (err.code === "UNAUTHENTICATED" || res.status === 401) fireUnauthenticated(path);
      throw new ApiError(err.code, err.message, res.status, err.details);
    }
    return {
      data: parsed.data as T,
      meta: (parsed.meta ?? {}) as ListMeta | Record<string, unknown>,
    };
  }

  // Non-envelope response.
  if (res.ok) {
    // e.g. 204: treat as null data.
    return { data: parsed as T, meta: {} };
  }
  // Error status with a non-envelope (or empty) body: synthesize a code.
  if (res.status === 401) fireUnauthenticated(path);
  throw new ApiError(fallbackCodeForStatus(res.status), res.statusText || "Request failed", res.status);
};

const fallbackCodeForStatus = (status: number): ErrorCode => {
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "RESOURCE_NOT_FOUND";
  if (status === 409) return "VERSION_CONFLICT";
  if (status === 422 || status === 400) return "VALIDATION_FAILED";
  if (status === 429) return "RATE_LIMITED";
  return "INTERNAL_ERROR";
};

export const get = async <T>(path: string, query?: QueryParams, signal?: AbortSignal): Promise<T> => {
  const { data } = await request<T>("GET", path, { query, signal });
  return data;
};

/** Optional per-write options (optimistic-concurrency version, abort signal). */
export interface WriteOptions {
  ifMatch?: number;
  signal?: AbortSignal;
}

export const post = async <T>(path: string, body?: unknown, opts?: WriteOptions): Promise<T> => {
  const { data } = await request<T>("POST", path, { body, signal: opts?.signal, ifMatch: opts?.ifMatch });
  return data;
};

export const patch = async <T>(path: string, body?: unknown, opts?: WriteOptions): Promise<T> => {
  const { data } = await request<T>("PATCH", path, { body, signal: opts?.signal, ifMatch: opts?.ifMatch });
  return data;
};

export const del = async <T>(path: string, opts?: WriteOptions): Promise<T> => {
  const { data } = await request<T>("DELETE", path, { signal: opts?.signal, ifMatch: opts?.ifMatch });
  return data;
};

export const list = async <T>(path: string, query?: ListQuery, signal?: AbortSignal): Promise<ListResult<T>> => {
  const { data, meta } = await request<T[]>("GET", path, { query, signal });
  return { data, meta: meta as ListMeta };
};

export const api = { get, post, patch, del, list };
