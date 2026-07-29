import type { AuthContext } from "@billy/types";
import nodemailer from "nodemailer";
import { loadConfig } from "@billy/config";
import { assertCapability, type DomainEventEmitter } from "@/platform/service.js";
import type { Logger } from "@billy/shared";
import { decryptField, encryptField } from "@/platform/crypto.js";
import type { SettingsRepository } from "@/modules/settings/repository.js";
import {
  DEFAULT_BRANDING_SETTINGS,
  DEFAULT_BUSINESS_SETTINGS,
  DEFAULT_DOCUMENTS_SETTINGS,
  DEFAULT_EMAIL_SETTINGS,
  DEFAULT_LOCALIZATION_SETTINGS,
  DEFAULT_NUMBERING_SETTINGS,
  DEFAULT_TAX_SETTINGS,
  DEFAULT_TOGGLES_SETTINGS,
  DEFAULT_USER_SETTINGS,
  type BrandingSettingsUpdateInput,
  type BusinessSettingsUpdateInput,
  type DocumentsSettingsUpdateInput,
  type EmailSettingsUpdateInput,
  type LocalizationSettingsUpdateInput,
  type NumberingSettingsUpdateInput,
  type TaxSettingsUpdateInput,
  type TogglesSettingsUpdateInput,
  type UserSettingsUpdateInput,
} from "@/modules/settings/schema.js";
import type {
  BrandingSettingsDoc,
  BusinessSettingsDoc,
  DocumentsSettingsDoc,
  EmailSettingsData,
  EmailSettingsView,
  LocalizationSettingsDoc,
  NumberingSettingsDoc,
  SettingsDataByKey,
  SettingsKey,
  TaxSettingsDoc,
  TogglesSettingsDoc,
  UserSettingsDoc,
} from "@/modules/settings/types.js";

/**
 * Settings business logic. All logic lives here, never
 * in controllers. Owns: get-or-create defaults for each singleton and the
 * per-user doc, capability-gated updates, and `settings.*` domain events. Every
 * repository call threads the mandatory `authContext`.
 *
 * Boundary: the three global singletons
 * (business/tax/numbering) require `canManageSettings` on **write** — the check
 * lives in the service so it is enforced regardless of the caller. Per-user
 * `/me/settings` is self-scoped only (no capability), keyed strictly on the
 * request `authContext.userId`.
 */

const DEFAULTS: SettingsDataByKey = {
  business: DEFAULT_BUSINESS_SETTINGS,
  tax: DEFAULT_TAX_SETTINGS,
  numbering: DEFAULT_NUMBERING_SETTINGS,
  branding: DEFAULT_BRANDING_SETTINGS,
  email: DEFAULT_EMAIL_SETTINGS,
  localization: DEFAULT_LOCALIZATION_SETTINGS,
  documents: DEFAULT_DOCUMENTS_SETTINGS,
  toggles: DEFAULT_TOGGLES_SETTINGS,
};

const toEmailView = (data: EmailSettingsData): EmailSettingsView => {
  const { smtpPasswordEnc, ...rest } = data;
  return { ...rest, smtpConfigured: Boolean(smtpPasswordEnc) };
};

const buildFrom = (data: EmailSettingsData): string => {
  const email = data.fromEmail ?? "no-reply@billy.local";
  const name = data.fromName ?? "Billy";
  return `${name} <${email}>`;
};

const errMessage = (err: unknown): string => {
  return err instanceof Error ? err.message : "unknown error";
};

export interface SettingsServiceDeps {
  repo: SettingsRepository;
  emitter: DomainEventEmitter;
  logger: Logger;
  /**
   * Key material for field-encrypting admin-set secrets (the SMTP password).
   * Defaults to `DATA_ENCRYPTION_KEY` from config; overridable in
   * tests. Never logged.
   */
  encryptionKey?: string;
}

/** Result of the SMTP test-send action. */
export interface EmailTestResult {
  ok: boolean;
  /** Transport mode used: real SMTP verify, or dev jsonTransport compose. */
  mode: "smtp" | "json";
  error?: string;
}

export class SettingsService {
  private readonly repo: SettingsRepository;
  private readonly emitter: DomainEventEmitter;
  private readonly logger: Logger;
  private readonly encryptionKey: string;

  constructor(deps: SettingsServiceDeps) {
    this.repo = deps.repo;
    this.emitter = deps.emitter;
    this.logger = deps.logger;
    this.encryptionKey = deps.encryptionKey ?? loadConfig().DATA_ENCRYPTION_KEY;
  }

  // ── Global business settings (canManageSettings on write) ──────────────────

  async getBusiness(ctx: AuthContext): Promise<BusinessSettingsDoc> {
    return (await this.repo.getOrCreate(ctx, "business", DEFAULTS.business)) as BusinessSettingsDoc;
  }

  async updateBusiness(ctx: AuthContext, input: BusinessSettingsUpdateInput): Promise<BusinessSettingsDoc> {
    return (await this.updateSingleton(ctx, "business", input)) as BusinessSettingsDoc;
  }

  // ── Global tax settings ────────────────────────────────────────────────────

  async getTax(ctx: AuthContext): Promise<TaxSettingsDoc> {
    return (await this.repo.getOrCreate(ctx, "tax", DEFAULTS.tax)) as TaxSettingsDoc;
  }

  async updateTax(ctx: AuthContext, input: TaxSettingsUpdateInput): Promise<TaxSettingsDoc> {
    return (await this.updateSingleton(ctx, "tax", input)) as TaxSettingsDoc;
  }

  // ── Global numbering settings ──────────────────────────────────────────────

  async getNumbering(ctx: AuthContext): Promise<NumberingSettingsDoc> {
    return (await this.repo.getOrCreate(ctx, "numbering", DEFAULTS.numbering)) as NumberingSettingsDoc;
  }

  async updateNumbering(ctx: AuthContext, input: NumberingSettingsUpdateInput): Promise<NumberingSettingsDoc> {
    return (await this.updateSingleton(ctx, "numbering", input)) as NumberingSettingsDoc;
  }

  // ── Customization: Branding ────────────────────────

  async getBranding(ctx: AuthContext): Promise<BrandingSettingsDoc> {
    return (await this.repo.getOrCreate(ctx, "branding", DEFAULTS.branding)) as BrandingSettingsDoc;
  }

  async updateBranding(ctx: AuthContext, input: BrandingSettingsUpdateInput): Promise<BrandingSettingsDoc> {
    return (await this.updateSingleton(ctx, "branding", input)) as BrandingSettingsDoc;
  }

  // ── Customization: Localization ────────────────────────────────────────────

  async getLocalization(ctx: AuthContext): Promise<LocalizationSettingsDoc> {
    return (await this.repo.getOrCreate(ctx, "localization", DEFAULTS.localization)) as LocalizationSettingsDoc;
  }

  async updateLocalization(ctx: AuthContext, input: LocalizationSettingsUpdateInput): Promise<LocalizationSettingsDoc> {
    return (await this.updateSingleton(ctx, "localization", input)) as LocalizationSettingsDoc;
  }

  // ── Customization: Documents ───────────────────────────────────────────────

  async getDocuments(ctx: AuthContext): Promise<DocumentsSettingsDoc> {
    return (await this.repo.getOrCreate(ctx, "documents", DEFAULTS.documents)) as DocumentsSettingsDoc;
  }

  async updateDocuments(ctx: AuthContext, input: DocumentsSettingsUpdateInput): Promise<DocumentsSettingsDoc> {
    return (await this.updateSingleton(ctx, "documents", input)) as DocumentsSettingsDoc;
  }

  // ── Customization: Feature toggles / policy ────────────────────────────────

  async getToggles(ctx: AuthContext): Promise<TogglesSettingsDoc> {
    return (await this.repo.getOrCreate(ctx, "toggles", DEFAULTS.toggles)) as TogglesSettingsDoc;
  }

  async updateToggles(ctx: AuthContext, input: TogglesSettingsUpdateInput): Promise<TogglesSettingsDoc> {
    return (await this.updateSingleton(ctx, "toggles", input)) as TogglesSettingsDoc;
  }

  // ── Customization: Email / SMTP (secret-safe) ───────────────

  /**
   * Read email settings as the API-safe {@link EmailSettingsView}: the encrypted
   * password (`smtpPasswordEnc`) is NEVER returned — instead `smtpConfigured`
   * reports whether one is set. This is the only email shape that
   * leaves the API.
   */
  async getEmail(ctx: AuthContext): Promise<EmailSettingsView> {
    const doc = await this.repo.getOrCreate(ctx, "email", DEFAULTS.email);
    return toEmailView(doc.data as EmailSettingsData);
  }

  /**
   * Update email settings. If `smtpPassword` (write-only plaintext) is present it
   * is field-encrypted into `smtpPasswordEnc` and the plaintext is dropped;
   * `null` clears the stored secret. The response is the secret-free view. The
   * password is never stored in plaintext, returned, or logged.
   */
  async updateEmail(ctx: AuthContext, input: EmailSettingsUpdateInput): Promise<EmailSettingsView> {
    assertCapability(ctx, "canManageSettings");
    const existing = await this.repo.getOrCreate(ctx, "email", DEFAULTS.email);
    const { smtpPassword, ...rest } = input;
    const patch: Partial<EmailSettingsData> = { ...rest };
    if (smtpPassword !== undefined) {
      // Encrypt on write; a null explicitly clears the stored secret.
      patch.smtpPasswordEnc =
        smtpPassword === null ? null : encryptField(smtpPassword, this.encryptionKey);
    }
    const updated = await this.repo.updateData(
      ctx,
      "email",
      existing.data as EmailSettingsData,
      patch,
    );
    await this.emitter.emit({
      name: "settings.email.updated",
      actorId: ctx.userId,
      entityType: "settings",
      entityId: "email",
    });
    return toEmailView(updated.data as EmailSettingsData);
  }

  /**
   * Test-send action: build a nodemailer transport from the CURRENT
   * email settings and validate it. With an SMTP host set, decrypt the stored
   * password and call `transport.verify()` (a real connection/auth check). With
   * no host (dev), use `jsonTransport` and compose a message — a no-server
   * success path so the panel gives immediate feedback. Errors are returned as
   * `{ ok:false, error }` (message only — never the credentials).
   */
  async testEmail(ctx: AuthContext): Promise<EmailTestResult> {
    assertCapability(ctx, "canManageSettings");
    const doc = await this.repo.getOrCreate(ctx, "email", DEFAULTS.email);
    const data = doc.data as EmailSettingsData;

    if (!data.smtpHost) {
      // Dev jsonTransport: compose a message with no server (always "ok").
      const transport = nodemailer.createTransport({ jsonTransport: true });
      try {
        await transport.sendMail({
          from: buildFrom(data),
          to: data.fromEmail ?? "test@billy.local",
          subject: "Billy SMTP test",
          text: "This is a Billy SMTP test message (jsonTransport, no server configured).",
        });
        return { ok: true, mode: "json" };
      } catch (err) {
        return { ok: false, mode: "json", error: errMessage(err) };
      } finally {
        transport.close();
      }
    }

    const password = data.smtpPasswordEnc
      ? decryptField(data.smtpPasswordEnc, this.encryptionKey)
      : undefined;
    const auth =
      data.smtpUsername && password ? { user: data.smtpUsername, pass: password } : undefined;
    const transport = nodemailer.createTransport({
      host: data.smtpHost,
      port: data.smtpPort,
      secure: data.smtpSecure,
      ...(auth ? { auth } : {}),
    });
    try {
      await transport.verify();
      // No credentials logged — routing metadata only.
      this.logger.info({ smtpHost: data.smtpHost, smtpPort: data.smtpPort }, "smtp test-send verified");
      return { ok: true, mode: "smtp" };
    } catch (err) {
      return { ok: false, mode: "smtp", error: errMessage(err) };
    } finally {
      transport.close();
    }
  }

  /**
   * Actually SEND a test message to `recipient` using the saved SMTP settings
   * (distinct from `testEmail`, which only verifies the connection). With no SMTP
   * host configured it uses the dev jsonTransport (composes, delivers nowhere) so
   * the call still succeeds. `canManageSettings`-gated.
   */
  async sendTestEmail(ctx: AuthContext, recipient: string): Promise<EmailTestResult> {
    assertCapability(ctx, "canManageSettings");
    const to = recipient.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(to)) {
      return { ok: false, mode: "smtp", error: "invalid recipient email" };
    }
    const doc = await this.repo.getOrCreate(ctx, "email", DEFAULTS.email);
    const data = doc.data as EmailSettingsData;
    const message = {
      from: buildFrom(data),
      to,
      subject: "Billy test email",
      text: "This is a test email from Billy. Your SMTP settings are working.",
      html: "<p>This is a test email from <strong>Billy</strong>. Your SMTP settings are working.</p>",
    };

    if (!data.smtpHost) {
      const transport = nodemailer.createTransport({ jsonTransport: true });
      try {
        await transport.sendMail(message);
        return { ok: true, mode: "json" };
      } catch (err) {
        return { ok: false, mode: "json", error: errMessage(err) };
      } finally {
        transport.close();
      }
    }

    const password = data.smtpPasswordEnc
      ? decryptField(data.smtpPasswordEnc, this.encryptionKey)
      : undefined;
    const auth =
      data.smtpUsername && password ? { user: data.smtpUsername, pass: password } : undefined;
    const transport = nodemailer.createTransport({
      host: data.smtpHost,
      port: data.smtpPort,
      secure: data.smtpSecure,
      ...(auth ? { auth } : {}),
    });
    try {
      await transport.sendMail(message);
      this.logger.info({ smtpHost: data.smtpHost, to }, "smtp test email sent");
      return { ok: true, mode: "smtp" };
    } catch (err) {
      return { ok: false, mode: "smtp", error: errMessage(err) };
    } finally {
      transport.close();
    }
  }

  /**
   * Shared singleton update: capability gate → get-or-create (so the row exists
   * and we hold its current data) → merge patch → emit. `canManageSettings` is
   * enforced here in the service (admins implicitly hold it).
   */
  private async updateSingleton<K extends SettingsKey>(
    ctx: AuthContext,
    key: K,
    patch: Partial<SettingsDataByKey[K]>,
  ) {
    assertCapability(ctx, "canManageSettings");
    const existing = await this.repo.getOrCreate(ctx, key, DEFAULTS[key]);
    const updated = await this.repo.updateData(
      ctx,
      key,
      existing.data as SettingsDataByKey[K],
      patch,
    );
    await this.emitter.emit({
      name: `settings.${key}.updated`,
      actorId: ctx.userId,
      entityType: "settings",
      entityId: key,
    });
    return updated;
  }

  // ── Per-user UI settings (self-scoped; no capability) ──────────────────────

  async getUserSettings(ctx: AuthContext): Promise<UserSettingsDoc> {
    return this.repo.getOrCreateUser(ctx, ctx.userId, DEFAULT_USER_SETTINGS);
  }

  async updateUserSettings(ctx: AuthContext, input: UserSettingsUpdateInput): Promise<UserSettingsDoc> {
    // Self-scoped: the key is ALWAYS ctx.userId — never read a userId from
    // params/body. That is the entire security boundary for /me/settings.
    const existing = await this.repo.getOrCreateUser(ctx, ctx.userId, DEFAULT_USER_SETTINGS);
    const { userId: _u, createdAt: _c, updatedAt: _up, ...currentData } = existing;
    void _u;
    void _c;
    void _up;
    const updated = await this.repo.updateUser(ctx, ctx.userId, currentData, input);
    await this.emitter.emit({
      name: "userSettings.updated",
      actorId: ctx.userId,
      entityType: "userSettings",
      entityId: ctx.userId,
    });
    return updated;
  }
}
