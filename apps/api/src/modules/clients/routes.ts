import Router from "@koa/router";
import type { Db } from "mongodb";
import { errors, type Logger } from "@billy/shared";
import type { AppState } from "@/app.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import { validate } from "@/platform/validate.js";
import { respondCreated, respondList, respondOk } from "@/platform/serializer.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import { ClientRepository, CLIENTS_COLLECTION } from "@/modules/clients/repository.js";
import { ClientService } from "@/modules/clients/service.js";
import { ClientCreateSchema, ClientUpdateSchema } from "@/modules/clients/schema.js";
import type { Client } from "@/modules/clients/types.js";

export const createClientsRouter = (deps: {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
}): Router<AppState> => {
  const repo = new ClientRepository(deps.db.collection<Client>(CLIENTS_COLLECTION));
  const service = new ClientService({ repo, emitter: deps.emitter, logger: deps.logger });

  const r = new Router<AppState>({ prefix: "/api/v1/clients" });

  r.use(requireAuth);

  // GET /api/v1/clients — list (server paginate/sort/search).
  r.get("/", async (ctx) => {
    const { items, meta } = await service.list(ctx.state.authContext!, ctx.query);
    respondList(ctx, items, meta);
  });

  // GET /api/v1/clients/:id
  r.get("/:id", async (ctx) => {
    const client = await service.get(ctx.state.authContext!, ctx.params.id!);
    respondOk(ctx, client);
  });

  // POST /api/v1/clients — create
  r.post("/", async (ctx) => {
    const input = validate(ClientCreateSchema, ctx.request.body);
    const created = await service.create(ctx.state.authContext!, input);
    respondCreated(ctx, created);
  });

  // PATCH /api/v1/clients/:id — versioned update (If-Match / body version)
  r.patch("/:id", async (ctx) => {
    const input = validate(ClientUpdateSchema, ctx.request.body);
    const expectedVersion = resolveVersion(ctx.get("if-match"), input.version);
    const updated = await service.update(ctx.state.authContext!, ctx.params.id!, expectedVersion, input);
    respondOk(ctx, updated);
  });

  // DELETE /api/v1/clients/:id — soft-delete (capability-gated in the service)
  r.delete("/:id", async (ctx) => {
    await service.softDelete(ctx.state.authContext!, ctx.params.id!);
    respondOk(ctx, { ok: true });
  });

  // POST /api/v1/clients/:id/archive — versioned archive
  r.post("/:id/archive", async (ctx) => {
    const expectedVersion = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const archived = await service.archive(ctx.state.authContext!, ctx.params.id!, expectedVersion);
    respondOk(ctx, archived);
  });

  // POST /api/v1/clients/:id/restore — versioned restore
  r.post("/:id/restore", async (ctx) => {
    const expectedVersion = resolveVersion(ctx.get("if-match"), bodyVersion(ctx.request.body));
    const restored = await service.restore(ctx.state.authContext!, ctx.params.id!, expectedVersion);
    respondOk(ctx, restored);
  });

  // POST /api/v1/clients/:id/anonymize — GDPR Art. 17 erasure-as-anonymization
  // (capability-gated in the service). Pseudonymizes PII in place; financial
  // records referencing the client retain their legally-required data.
  r.post("/:id/anonymize", async (ctx) => {
    const anonymized = await service.anonymize(ctx.state.authContext!, ctx.params.id!);
    respondOk(ctx, anonymized);
  });

  return r;
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
