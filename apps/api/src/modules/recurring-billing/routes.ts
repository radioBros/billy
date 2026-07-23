import Router from "@koa/router";
import type { Db } from "mongodb";
import { errors, type Logger } from "@billy/shared";
import type { AuthContext } from "@billy/types";
import type { AppState } from "@/app.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import { validate } from "@/platform/validate.js";
import { canSeeFinancials, respondCreated, respondList, respondOk } from "@/platform/serializer.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import { RecurringProfileRepository, RECURRING_PROFILES_COLLECTION } from "@/modules/recurring-billing/repository.js";
import { RecurringProfileService } from "@/modules/recurring-billing/service.js";
import { RecurringProfileCreateSchema, RecurringProfileUpdateSchema } from "@/modules/recurring-billing/schema.js";
import type { RecurringProfile } from "@/modules/recurring-billing/types.js";

export const createRecurringBillingRouter = (deps: {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
}): Router<AppState> => {
  const repo = new RecurringProfileRepository(
    deps.db.collection<RecurringProfile>(RECURRING_PROFILES_COLLECTION),
  );
  const service = new RecurringProfileService({ repo, emitter: deps.emitter, logger: deps.logger });

  const r = new Router<AppState>({ prefix: "/api/v1/recurring-profiles" });
  r.use(requireAuth);

  // GET /api/v1/recurring-profiles — list
  r.get("/", async (ctx) => {
    const auth = ctx.state.authContext!;
    const { items, meta } = await service.list(auth, ctx.query);
    respondList(ctx, items.map((p) => stripProfileFinancial(auth, p)), meta);
  });

  // GET /api/v1/recurring-profiles/:id
  r.get("/:id", async (ctx) => {
    const auth = ctx.state.authContext!;
    const p = await service.get(auth, ctx.params.id!);
    respondOk(ctx, stripProfileFinancial(auth, p));
  });

  // POST /api/v1/recurring-profiles — create (active)
  r.post("/", async (ctx) => {
    const auth = ctx.state.authContext!;
    const input = validate(RecurringProfileCreateSchema, ctx.request.body);
    const created = await service.create(auth, input);
    respondCreated(ctx, stripProfileFinancial(auth, created));
  });

  // PATCH /api/v1/recurring-profiles/:id — versioned edit
  r.patch("/:id", async (ctx) => {
    const auth = ctx.state.authContext!;
    const input = validate(RecurringProfileUpdateSchema, ctx.request.body);
    const version = resolveVersion(ctx.get("if-match"), input.version);
    const updated = await service.update(auth, ctx.params.id!, version, input);
    respondOk(ctx, stripProfileFinancial(auth, updated));
  });

  // DELETE /api/v1/recurring-profiles/:id — soft-delete
  r.delete("/:id", async (ctx) => {
    const auth = ctx.state.authContext!;
    await service.softDelete(auth, ctx.params.id!);
    respondOk(ctx, { ok: true });
  });

  // POST /api/v1/recurring-profiles/:id/archive
  r.post("/:id/archive", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const archived = await service.archive(auth, ctx.params.id!, version);
    respondOk(ctx, stripProfileFinancial(auth, archived));
  });

  // POST /api/v1/recurring-profiles/:id/restore
  r.post("/:id/restore", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const restored = await service.restore(auth, ctx.params.id!, version);
    respondOk(ctx, stripProfileFinancial(auth, restored));
  });

  // POST /api/v1/recurring-profiles/:id/pause
  r.post("/:id/pause", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const paused = await service.pause(auth, ctx.params.id!, version);
    respondOk(ctx, stripProfileFinancial(auth, paused));
  });

  // POST /api/v1/recurring-profiles/:id/resume
  r.post("/:id/resume", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const resumed = await service.resume(auth, ctx.params.id!, version);
    respondOk(ctx, stripProfileFinancial(auth, resumed));
  });

  // POST /api/v1/recurring-profiles/:id/cancel
  r.post("/:id/cancel", async (ctx) => {
    const auth = ctx.state.authContext!;
    const version = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const cancelled = await service.cancel(auth, ctx.params.id!, version);
    respondOk(ctx, stripProfileFinancial(auth, cancelled));
  });

  // POST /api/v1/recurring-profiles/:id/generate — idempotent occurrence draft.
  // Returns the InvoiceDraftPayload (jobs layer creates the invoice); null when
  // the profile completed without generating.
  r.post("/:id/generate", async (ctx) => {
    const auth = ctx.state.authContext!;
    const payload = await service.generateOccurrence(auth, ctx.params.id!);
    respondOk(ctx, payload);
  });

  return r;
};

/** Top-level money fields removed for non-financial callers. */
const PROFILE_MONEY_FIELDS = ["subtotalMinor", "discountMinor", "taxMinor", "grandTotalMinor"] as const;
const LINE_MONEY_FIELDS = ["unitPriceMinor", "lineSubtotalMinor", "lineDiscountMinor", "lineTaxMinor", "lineTotalMinor"];

export const stripProfileFinancial = (ctx: AuthContext, profile: RecurringProfile): RecurringProfile => {
  if (canSeeFinancials(ctx)) return profile;
  const copy = { ...profile } as Record<string, unknown>;
  for (const f of PROFILE_MONEY_FIELDS) delete copy[f];
  if (Array.isArray(profile.lineItems)) {
    copy.lineItems = profile.lineItems.map((li) => {
      const l = { ...(li as unknown as Record<string, unknown>) };
      for (const f of LINE_MONEY_FIELDS) delete l[f];
      return l;
    });
  }
  return copy as unknown as RecurringProfile;
};

const bodyVersion = (body: unknown): number | undefined => {
  if (body && typeof body === "object" && "version" in body) {
    const v = (body as { version?: unknown }).version;
    if (typeof v === "number") return v;
  }
  return undefined;
};

const resolveVersion = (ifMatch: string | undefined, bodyVal: number | undefined): number => {
  const header = ifMatch?.trim().replace(/^"(.*)"$/u, "$1");
  if (header && /^\d+$/u.test(header)) return Number(header);
  if (typeof bodyVal === "number" && Number.isInteger(bodyVal) && bodyVal >= 0) return bodyVal;
  throw errors.validation("Missing or invalid version (If-Match header or body `version` required)", {
    version: "field.required",
  });
};
