import Router from "@koa/router";
import type { Context } from "koa";
import type { Db } from "mongodb";
import type { AuthContext, ListMeta } from "@billy/types";
import type { Logger } from "@billy/shared";
import { errors } from "@billy/shared";
import { validate } from "@/platform/validate.js";
import { respondOk, respondCreated, respondList, stripFinancial, stripFinancialList } from "@/platform/serializer.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import type { AppState } from "@/app.js";
import { TimeEntryRepository, TIME_ENTRIES_COLLECTION } from "@/modules/time-tracking/repository.js";
import { TimeEntryService } from "@/modules/time-tracking/service.js";
import type { TimeEntry } from "@/modules/time-tracking/types.js";
import { TIME_ENTRY_FINANCIAL_FIELDS } from "@/modules/time-tracking/types.js";
import {
  TimeEntryCreateSchema,
  TimeEntryUpdateSchema,
  TimerStartSchema,
  TimerActionSchema,
  MarkBilledSchema,
} from "@/modules/time-tracking/schema.js";
import type { ParsedListQuery } from "@/platform/list-query.js";

const requireVersion = (ctx: Context): number => {
  const header = ctx.get("if-match");
  const fromHeader = header ? Number(header.replace(/"/gu, "")) : NaN;
  if (Number.isInteger(fromHeader)) return fromHeader;
  const body = (ctx.request.body ?? {}) as { version?: unknown };
  if (Number.isInteger(body.version)) return body.version as number;
  throw errors.validation("Missing version (If-Match header or body.version)", { version: "field.required" });
};

const listMeta = (parsed: ParsedListQuery, total: number): ListMeta => {
  return {
    page: parsed.page,
    limit: parsed.limit,
    total,
    pageCount: parsed.limit > 0 ? Math.ceil(total / parsed.limit) : 0,
    sort: parsed.sortSpec,
    ...(parsed.q ? { q: parsed.q } : {}),
  };
};

export const createTimeTrackingRouter = (deps: {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
}): Router<AppState> => {
  const repo = new TimeEntryRepository(deps.db.collection<TimeEntry>(TIME_ENTRIES_COLLECTION));
  const service = new TimeEntryService({ repo, emitter: deps.emitter, logger: deps.logger });

  const r = new Router<AppState>({ prefix: "/api/v1/time-entries" });

  const authCtx = (ctx: { state: AppState }): AuthContext => ctx.state.authContext as AuthContext;

  /** Strip financial fields for one entry (adapts TimeEntry to the serializer's record generic). */
  const strip = (auth: AuthContext, entry: TimeEntry): Record<string, unknown> =>
    stripFinancial(auth, entry as unknown as Record<string, unknown>, TIME_ENTRY_FINANCIAL_FIELDS);

  const stripList = (auth: AuthContext, entries: TimeEntry[]): Record<string, unknown>[] =>
    stripFinancialList(auth, entries as unknown as Record<string, unknown>[], TIME_ENTRY_FINANCIAL_FIELDS);

  /** Path `:id` is always present for these routes; guard narrows the koa-router optional. */
  const pathId = (ctx: Context): string => {
    const id = ctx.params.id;
    if (!id) throw errors.notFound();
    return id;
  };

  // List
  r.get("/", requireAuth, async (ctx) => {
    const auth = authCtx(ctx);
    const { items, parsed, total } = await service.list(auth, ctx.query);
    respondList(ctx, stripList(auth, items), listMeta(parsed, total));
  });

  // Timer control — declared before `/:id` so the literal paths win.
  r.post("/timer/start", requireAuth, async (ctx) => {
    const auth = authCtx(ctx);
    const input = validate(TimerStartSchema, ctx.request.body ?? {});
    const entry = await service.startTimer(auth, input);
    respondCreated(ctx, strip(auth, entry));
  });

  r.post("/timer/stop", requireAuth, async (ctx) => {
    const auth = authCtx(ctx);
    const { id } = validate(TimerActionSchema, ctx.request.body ?? {});
    const entry = await service.stopTimer(auth, id);
    respondOk(ctx, strip(auth, entry));
  });

  r.post("/timer/pause", requireAuth, async (ctx) => {
    const auth = authCtx(ctx);
    const { id } = validate(TimerActionSchema, ctx.request.body ?? {});
    const entry = await service.pauseTimer(auth, id);
    respondOk(ctx, strip(auth, entry));
  });

  r.post("/timer/resume", requireAuth, async (ctx) => {
    const auth = authCtx(ctx);
    const { id } = validate(TimerActionSchema, ctx.request.body ?? {});
    const entry = await service.resumeTimer(auth, id);
    respondOk(ctx, strip(auth, entry));
  });

  // Create
  r.post("/", requireAuth, async (ctx) => {
    const auth = authCtx(ctx);
    const input = validate(TimeEntryCreateSchema, ctx.request.body ?? {});
    const entry = await service.create(auth, input);
    respondCreated(ctx, strip(auth, entry));
  });

  // Read one
  r.get("/:id", requireAuth, async (ctx) => {
    const auth = authCtx(ctx);
    const entry = await service.getById(auth, pathId(ctx));
    respondOk(ctx, strip(auth, entry));
  });

  // Update
  r.patch("/:id", requireAuth, async (ctx) => {
    const auth = authCtx(ctx);
    const version = requireVersion(ctx);
    const patch = validate(TimeEntryUpdateSchema, ctx.request.body ?? {});
    const entry = await service.update(auth, pathId(ctx), version, patch);
    respondOk(ctx, strip(auth, entry));
  });

  // Soft-delete
  r.delete("/:id", requireAuth, async (ctx) => {
    await service.softDelete(authCtx(ctx), pathId(ctx));
    respondOk(ctx, { ok: true });
  });

  // Archive / restore
  r.post("/:id/archive", requireAuth, async (ctx) => {
    const auth = authCtx(ctx);
    const version = requireVersion(ctx);
    const entry = await service.archive(auth, pathId(ctx), version);
    respondOk(ctx, strip(auth, entry));
  });

  r.post("/:id/restore", requireAuth, async (ctx) => {
    const auth = authCtx(ctx);
    const version = requireVersion(ctx);
    const entry = await service.restore(auth, pathId(ctx), version);
    respondOk(ctx, strip(auth, entry));
  });

  // Mark billed (invoice-from-time linkage)
  r.post("/:id/mark-billed", requireAuth, async (ctx) => {
    const auth = authCtx(ctx);
    const { invoiceId } = validate(MarkBilledSchema, ctx.request.body ?? {});
    const entry = await service.markBilled(auth, pathId(ctx), invoiceId);
    respondOk(ctx, strip(auth, entry));
  });

  return r;
};
