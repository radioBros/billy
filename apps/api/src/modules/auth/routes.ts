import Router from "@koa/router";
import type { Context } from "koa";
import { z } from "zod";
import QRCode from "qrcode";
import { errors } from "@billy/shared";
import { NonEmptyString } from "@billy/validation";
import { validate } from "@/platform/validate.js";
import { respondOk } from "@/platform/serializer.js";
import type { AppState } from "@/app.js";
import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/modules/auth/session.js";
import { LoginBodySchema, PasswordPolicy } from "@/modules/auth/users.js";
import { requireAuth } from "@/modules/auth/middleware.js";
import type { AuthService } from "@/modules/auth/auth-service.js";

const ChangePasswordSchema = z.object({
  currentPassword: NonEmptyString,
  newPassword: PasswordPolicy,
});

const CodeSchema = z.object({ code: NonEmptyString });

const VerifyTwoFactorSchema = z.object({
  pendingToken: NonEmptyString,
  code: NonEmptyString,
});

const DisableTwoFactorSchema = z
  .object({
    code: NonEmptyString.optional(),
    password: NonEmptyString.optional(),
  })
  .refine((v) => Boolean(v.code) || Boolean(v.password), { message: "code or password is required" });

export const createAuthRouter = (deps: { authService: AuthService; isProd: boolean }): Router<AppState> => {
  const r = new Router<AppState>({ prefix: "/api/v1/auth" });

  const setSessionCookie = (ctx: Context, token: string, maxAgeMs: number): void => {
    ctx.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions({ isProd: deps.isProd, maxAgeMs }));
  };

  // POST /login — password step. For a 2FA user returns { status:"2fa_required",
  // pendingToken, expiresInMs } and does NOT set a session cookie; the client
  // must call /login/verify-2fa. For a non-2FA user the behaviour is unchanged:
  // sets the session cookie and returns { status:"authenticated", ...principal }.
  r.post("/login", async (ctx) => {
    const { email, password } = validate(LoginBodySchema, ctx.request.body);
    const outcome = await deps.authService.login(email, password, ctx.ip, ctx.get("user-agent"));
    if (outcome.status === "2fa_required") {
      respondOk(ctx, { status: "2fa_required", pendingToken: outcome.pendingToken, expiresInMs: outcome.expiresInMs });
      return;
    }
    setSessionCookie(ctx, outcome.token, outcome.maxAgeMs);
    respondOk(ctx, { status: "authenticated", ...outcome.principal });
  });

  // POST /login/verify-2fa — second step. Exchanges the pending token + a TOTP or
  // backup code for a full session; sets the session cookie and returns the principal.
  r.post("/login/verify-2fa", async (ctx) => {
    const { pendingToken, code } = validate(VerifyTwoFactorSchema, ctx.request.body);
    const result = await deps.authService.verifyLoginTwoFactor(pendingToken, code, ctx.ip, ctx.get("user-agent"));
    setSessionCookie(ctx, result.token, result.maxAgeMs);
    respondOk(ctx, { status: "authenticated", ...result.principal });
  });

  r.post("/logout", async (ctx) => {
    await deps.authService.logout(ctx.cookies.get(SESSION_COOKIE_NAME) ?? undefined);
    ctx.cookies.set(SESSION_COOKIE_NAME, null);
    respondOk(ctx, { ok: true });
  });

  r.post("/refresh", async (ctx) => {
    const result = await deps.authService.refresh(ctx.cookies.get(SESSION_COOKIE_NAME) ?? undefined);
    if (!result) throw errors.unauthenticated();
    setSessionCookie(ctx, result.token, result.maxAgeMs);
    respondOk(ctx, result.principal);
  });

  r.get("/me", requireAuth, (ctx) => {
    respondOk(ctx, ctx.state.principal);
  });

  // POST /assume-account — SYSADMIN account switch. Hard-gated: requireAuth AND
  // the sysadmin role (the service also re-checks). Sets the session's active
  // account; the next request resolves under it.
  r.post("/assume-account", requireAuth, async (ctx) => {
    const auth = ctx.state.authContext!;
    if (!auth.isSysadmin) throw errors.forbidden("Sysadmin only");
    const body = ctx.request.body as { accountId?: unknown };
    const accountId = typeof body?.accountId === "string" ? body.accountId : "";
    if (!accountId) throw errors.validation("accountId is required", { accountId: "field.required" });
    const ok = await deps.authService.assumeAccount(ctx.cookies.get(SESSION_COOKIE_NAME) ?? undefined, accountId);
    if (!ok) throw errors.notFound("Account not found or not assumable");
    respondOk(ctx, { ok: true, accountId });
  });

  // POST /change-password (self-service). Verifies the current password, applies
  // the new one, clears mustChangePassword, and revokes all OTHER sessions.
  r.post("/change-password", requireAuth, async (ctx) => {
    const { currentPassword, newPassword } = validate(ChangePasswordSchema, ctx.request.body);
    await deps.authService.changePassword(ctx.state.authContext!.userId, currentPassword, newPassword);
    respondOk(ctx, { ok: true });
  });

  // ── TOTP two-factor enrolment ───────────────────────────────────────────────

  // POST /totp/setup — generate a pending secret + return the otpauth URL and a
  // ready-to-render QR data URL. Does NOT enable 2FA (verify-before-enable).
  r.post("/totp/setup", requireAuth, async (ctx) => {
    const { otpauthUrl } = await deps.authService.totpSetup(ctx.state.authContext!.userId);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
    respondOk(ctx, { otpauthUrl, qrDataUrl });
  });

  // POST /totp/enable { code } — verify a live code against the pending secret,
  // enable 2FA, and return the one-time backup codes (shown once).
  r.post("/totp/enable", requireAuth, async (ctx) => {
    const { code } = validate(CodeSchema, ctx.request.body);
    const { backupCodes } = await deps.authService.totpEnable(ctx.state.authContext!.userId, code);
    respondOk(ctx, { enabled: true, backupCodes });
  });

  // POST /totp/disable { code? | password? } — re-auth then disable 2FA.
  r.post("/totp/disable", requireAuth, async (ctx) => {
    const body = validate(DisableTwoFactorSchema, ctx.request.body);
    await deps.authService.totpDisable(ctx.state.authContext!.userId, body);
    respondOk(ctx, { enabled: false });
  });

  return r;
};
