import type Router from "@koa/router";
import type { AppDeps, AppState } from "@/app.js";

/**
 * Health endpoints.
 * - /health/live         : liveness — process is up (no dependency checks).
 * - /health/ready         : readiness — 200 only if ALL probes pass, else 503.
 * - /health/dependencies  : per-dependency detail + degraded flag.
 */

export type DependencyProbes = Record<string, () => Promise<void>>;

type ProbeResult =
  | { status: "up"; latencyMs: number }
  | { status: "down"; error: string };

async function runProbes(probes: DependencyProbes): Promise<Record<string, ProbeResult>> {
  const entries = await Promise.all(
    Object.entries(probes).map(async ([name, probe]): Promise<[string, ProbeResult]> => {
      const start = Date.now();
      try {
        await probe();
        return [name, { status: "up", latencyMs: Date.now() - start }];
      } catch (err) {
        return [name, { status: "down", error: err instanceof Error ? err.message : "unknown error" }];
      }
    }),
  );
  return Object.fromEntries(entries);
}

export function registerHealthRoutes(router: Router<AppState>, deps: AppDeps): void {
  router.get("/health/live", (ctx) => {
    ctx.body = { status: "ok" };
  });

  router.get("/health/ready", async (ctx) => {
    const checks = await runProbes(deps.probes);
    const allUp = Object.values(checks).every((c) => c.status === "up");
    ctx.status = allUp ? 200 : 503;
    ctx.body = { status: allUp ? "ready" : "not-ready", checks };
  });

  router.get("/health/dependencies", async (ctx) => {
    const dependencies = await runProbes(deps.probes);
    const anyDown = Object.values(dependencies).some((c) => c.status === "down");
    ctx.status = anyDown ? 503 : 200;
    ctx.body = { status: anyDown ? "degraded" : "ok", dependencies };
  });

  // Prometheus scrape endpoint (/metrics). Gated by
  // METRICS_ENABLED. Kept dependency-free — emits process/runtime gauges in the
  // Prometheus text exposition format rather than pulling in prom-client; richer
  // per-route/queue histograms are a follow-up. NOT routed publicly by the proxy.
  router.get("/metrics", (ctx) => {
    if (!deps.config.METRICS_ENABLED) {
      ctx.status = 404;
      return;
    }
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const lines = [
      "# HELP billy_process_uptime_seconds Process uptime in seconds.",
      "# TYPE billy_process_uptime_seconds gauge",
      `billy_process_uptime_seconds ${process.uptime()}`,
      "# HELP billy_process_resident_memory_bytes Resident set size in bytes.",
      "# TYPE billy_process_resident_memory_bytes gauge",
      `billy_process_resident_memory_bytes ${mem.rss}`,
      "# HELP billy_process_heap_used_bytes V8 heap used in bytes.",
      "# TYPE billy_process_heap_used_bytes gauge",
      `billy_process_heap_used_bytes ${mem.heapUsed}`,
      "# HELP billy_process_cpu_user_seconds_total User CPU time in seconds.",
      "# TYPE billy_process_cpu_user_seconds_total counter",
      `billy_process_cpu_user_seconds_total ${cpu.user / 1e6}`,
      "# HELP billy_process_cpu_system_seconds_total System CPU time in seconds.",
      "# TYPE billy_process_cpu_system_seconds_total counter",
      `billy_process_cpu_system_seconds_total ${cpu.system / 1e6}`,
      "# HELP billy_build_info Static build/runtime info.",
      "# TYPE billy_build_info gauge",
      `billy_build_info{env="${deps.config.APP_ENV}",node="${process.version}"} 1`,
      "",
    ];
    ctx.set("content-type", "text/plain; version=0.0.4; charset=utf-8");
    ctx.body = lines.join("\n");
  });
}
