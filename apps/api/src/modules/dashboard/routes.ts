import Router from "@koa/router";
import type { Db } from "mongodb";
import { errors, type Logger } from "@billy/shared";
import type { AppState } from "@/app.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import { respondOk } from "@/platform/serializer.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import { DashboardService } from "@/modules/dashboard/service.js";

export const createDashboardRouter = (deps: {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
}): Router<AppState> => {
  const service = new DashboardService({ db: deps.db, logger: deps.logger });

  const r = new Router<AppState>({ prefix: "/api/v1/dashboard" });
  r.use(requireAuth);

  const authOf = (ctx: { state: AppState }) => {
    const auth = ctx.state.authContext;
    if (!auth) throw errors.unauthenticated();
    return auth;
  };

  /** Parse a `?year=YYYY` query param → a plausible 4-digit year, or undefined
   *  (service then defaults to the current year). Guards against garbage/range. */
  const parseYear = (raw: string | string[] | undefined): number | undefined => {
    const s = Array.isArray(raw) ? raw[0] : raw;
    if (s == null || s === "") return undefined;
    const y = Number(s);
    if (!Number.isFinite(y)) return undefined;
    const yi = Math.trunc(y);
    if (yi < 1970 || yi > 9999) return undefined;
    return yi;
  };

  /** Parse `?months=1,3,12` (or repeated `months=`) → sorted unique 1..12, or
   *  undefined (⇒ whole year). Garbage entries are dropped. */
  const parseMonths = (raw: string | string[] | undefined): number[] | undefined => {
    if (raw == null) return undefined;
    const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((s) => s.split(","));
    const set = new Set<number>();
    for (const p of parts) {
      const n = Number(p.trim());
      if (Number.isInteger(n) && n >= 1 && n <= 12) set.add(n);
    }
    return set.size > 0 ? [...set].sort((a, b) => a - b) : undefined;
  };

  // GET /summary?year=YYYY&months=1,2,3 — KPI aggregate payload (counts + recent
  // activity + gated financials), scoped to `year` (default current) and an
  // optional month subset (default whole year). recentActivity stays rolling-30d.
  r.get("/summary", async (ctx) => {
    const auth = authOf(ctx);
    const summary = await service.summary(auth, parseYear(ctx.query.year), parseMonths(ctx.query.months));
    respondOk(ctx, summary);
  });

  // GET /revenue-series?year=YYYY — all 12 months of the year: invoiced/collected
  // + expenses per currency (for the revenue/expense chart). Financial data →
  // gated by canViewFinancialTotals (empty otherwise).
  r.get("/revenue-series", async (ctx) => {
    const auth = authOf(ctx);
    const series = await service.revenueSeries(auth, parseYear(ctx.query.year));
    respondOk(ctx, series);
  });

  // GET /monthly-counts?year=YYYY — per-month (1..12) doc counts by type + total
  // (counts chart + heatmap). Non-financial; not financial-gated.
  r.get("/monthly-counts", async (ctx) => {
    const auth = authOf(ctx);
    const counts = await service.monthlyCounts(auth, parseYear(ctx.query.year));
    respondOk(ctx, counts);
  });

  // GET /monthly-totals?kind=invoices&year=YYYY — per-month {count, totals} for a
  // single list kind (invoices/quotes/proformas/creditNotes/expenses/contracts),
  // powering the list-page month bar. Money totals are financial-gated; counts
  // are always returned.
  r.get("/monthly-totals", async (ctx) => {
    const auth = authOf(ctx);
    const kindRaw = ctx.query.kind;
    const kind = Array.isArray(kindRaw) ? kindRaw[0] : kindRaw;
    if (!kind) throw errors.validation("Missing required query param: kind");
    const totals = await service.monthlyTotals(auth, kind, parseYear(ctx.query.year));
    respondOk(ctx, totals);
  });

  // GET /years — {minYear, maxYear} available-year range for the year dropdown.
  r.get("/years", async (ctx) => {
    const auth = authOf(ctx);
    const years = await service.years(auth);
    respondOk(ctx, years);
  });

  return r;
};
