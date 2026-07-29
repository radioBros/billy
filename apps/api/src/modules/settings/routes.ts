import Router from "@koa/router";
import type { Db } from "mongodb";
import type { Logger } from "@billy/shared";
import type { AppState } from "@/app.js";
import type { DomainEventEmitter } from "@/platform/service.js";
import { validate } from "@/platform/validate.js";
import { respondOk } from "@/platform/serializer.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import {
  SettingsRepository,
  SETTINGS_COLLECTION,
  USER_SETTINGS_COLLECTION,
} from "@/modules/settings/repository.js";
import { SettingsService } from "@/modules/settings/service.js";
import {
  BrandingSettingsUpdateSchema,
  BusinessSettingsUpdateSchema,
  DocumentsSettingsUpdateSchema,
  EmailSettingsUpdateSchema,
  LocalizationSettingsUpdateSchema,
  NumberingSettingsUpdateSchema,
  TaxSettingsUpdateSchema,
  TogglesSettingsUpdateSchema,
  UserSettingsUpdateSchema,
} from "@/modules/settings/schema.js";
import type { SettingsDoc, UserSettingsDoc } from "@/modules/settings/types.js";

export const createSettingsRouter = (deps: {
  db: Db;
  emitter: DomainEventEmitter;
  logger: Logger;
}): Router<AppState> => {
  const repo = new SettingsRepository(
    deps.db.collection<SettingsDoc>(SETTINGS_COLLECTION),
    deps.db.collection<UserSettingsDoc>(USER_SETTINGS_COLLECTION),
  );
  const service = new SettingsService({ repo, emitter: deps.emitter, logger: deps.logger });

  const r = new Router<AppState>({ prefix: "/api/v1" });

  r.use(requireAuth);

  // ── Per-user UI settings (self-scoped via ctx.state.authContext.userId) ────

  // GET /api/v1/me/settings — auto-creates defaults on first access.
  r.get("/me/settings", async (ctx) => {
    const doc = await service.getUserSettings(ctx.state.authContext!);
    respondOk(ctx, doc);
  });

  // PATCH /api/v1/me/settings
  r.patch("/me/settings", async (ctx) => {
    const input = validate(UserSettingsUpdateSchema, ctx.request.body);
    const doc = await service.updateUserSettings(ctx.state.authContext!, input);
    respondOk(ctx, doc);
  });

  // ── Global business settings (canManageSettings on write, in service) ──────

  r.get("/settings/business", async (ctx) => {
    respondOk(ctx, (await service.getBusiness(ctx.state.authContext!)).data);
  });

  r.patch("/settings/business", async (ctx) => {
    const input = validate(BusinessSettingsUpdateSchema, ctx.request.body);
    respondOk(ctx, (await service.updateBusiness(ctx.state.authContext!, input)).data);
  });

  // ── Global tax settings ────────────────────────────────────────────────────

  r.get("/settings/tax", async (ctx) => {
    respondOk(ctx, (await service.getTax(ctx.state.authContext!)).data);
  });

  r.patch("/settings/tax", async (ctx) => {
    const input = validate(TaxSettingsUpdateSchema, ctx.request.body);
    respondOk(ctx, (await service.updateTax(ctx.state.authContext!, input)).data);
  });

  // ── Global numbering settings ──────────────────────────────────────────────

  r.get("/settings/numbering", async (ctx) => {
    respondOk(ctx, (await service.getNumbering(ctx.state.authContext!)).data);
  });

  r.patch("/settings/numbering", async (ctx) => {
    const input = validate(NumberingSettingsUpdateSchema, ctx.request.body);
    respondOk(ctx, (await service.updateNumbering(ctx.state.authContext!, input)).data);
  });

  // ── Customization: Branding (canManageSettings on write, in service) ───────

  r.get("/settings/branding", async (ctx) => {
    respondOk(ctx, (await service.getBranding(ctx.state.authContext!)).data);
  });

  r.patch("/settings/branding", async (ctx) => {
    const input = validate(BrandingSettingsUpdateSchema, ctx.request.body);
    respondOk(ctx, (await service.updateBranding(ctx.state.authContext!, input)).data);
  });

  // ── Customization: Email / SMTP ────────────────────────────────────────────
  // GET returns the secret-free view (`smtpConfigured`, never the password).

  r.get("/settings/email", async (ctx) => {
    respondOk(ctx, await service.getEmail(ctx.state.authContext!));
  });

  r.patch("/settings/email", async (ctx) => {
    const input = validate(EmailSettingsUpdateSchema, ctx.request.body);
    respondOk(ctx, await service.updateEmail(ctx.state.authContext!, input));
  });

  // POST /settings/email/test — validate the SMTP connection (no message sent).
  r.post("/settings/email/test", async (ctx) => {
    respondOk(ctx, await service.testEmail(ctx.state.authContext!));
  });

  // POST /settings/email/send-test — actually deliver a test message to `to`.
  r.post("/settings/email/send-test", async (ctx) => {
    const body = (ctx.request.body ?? {}) as { to?: unknown };
    const to = typeof body.to === "string" ? body.to : "";
    respondOk(ctx, await service.sendTestEmail(ctx.state.authContext!, to));
  });

  // ── Customization: Localization ────────────────────────────────────────────

  r.get("/settings/localization", async (ctx) => {
    respondOk(ctx, (await service.getLocalization(ctx.state.authContext!)).data);
  });

  r.patch("/settings/localization", async (ctx) => {
    const input = validate(LocalizationSettingsUpdateSchema, ctx.request.body);
    respondOk(ctx, (await service.updateLocalization(ctx.state.authContext!, input)).data);
  });

  // ── Customization: Documents ───────────────────────────────────────────────

  r.get("/settings/documents", async (ctx) => {
    respondOk(ctx, (await service.getDocuments(ctx.state.authContext!)).data);
  });

  r.patch("/settings/documents", async (ctx) => {
    const input = validate(DocumentsSettingsUpdateSchema, ctx.request.body);
    respondOk(ctx, (await service.updateDocuments(ctx.state.authContext!, input)).data);
  });

  // ── Customization: Feature toggles / policy ────────────────────────────────

  r.get("/settings/toggles", async (ctx) => {
    respondOk(ctx, (await service.getToggles(ctx.state.authContext!)).data);
  });

  r.patch("/settings/toggles", async (ctx) => {
    const input = validate(TogglesSettingsUpdateSchema, ctx.request.body);
    respondOk(ctx, (await service.updateToggles(ctx.state.authContext!, input)).data);
  });

  return r;
};
