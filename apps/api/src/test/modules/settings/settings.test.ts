import { describe, it, expect } from "vitest";
import type { Collection } from "mongodb";
import { createLogger } from "@billy/shared";
import type { AuthContext } from "@billy/types";
import type { DomainEvent, DomainEventEmitter } from "@/platform/service.js";
import { SettingsRepository } from "@/modules/settings/repository.js";
import { SettingsService } from "@/modules/settings/service.js";
import { decryptField } from "@/platform/crypto.js";
import {
  BrandingSettingsUpdateSchema,
  EmailSettingsUpdateSchema,
  LocalizationSettingsUpdateSchema,
} from "@/modules/settings/schema.js";
import {
  BusinessSettingsUpdateSchema,
  NumberingSettingsUpdateSchema,
  TaxSettingsUpdateSchema,
  UserSettingsUpdateSchema,
  DEFAULT_BUSINESS_SETTINGS,
  DEFAULT_NUMBERING_SETTINGS,
  DEFAULT_TAX_SETTINGS,
  DEFAULT_USER_SETTINGS,
} from "@/modules/settings/schema.js";
import type {
  SettingsDataByKey,
  SettingsDoc,
  SettingsKey,
  UserSettingsData,
  UserSettingsDoc,
} from "@/modules/settings/types.js";

// ── Test doubles ─────────────────────────────────────────────────────────────

const logger = createLogger({ level: "silent", pretty: false, service: "test" });

const newEmitter = (): { emitter: DomainEventEmitter; events: DomainEvent[] } => {
  const events: DomainEvent[] = [];
  return { emitter: { emit: (e) => void events.push(e) }, events };
};

const ADMIN: AuthContext = {
  userId: "u-admin",
  role: "administrator",
  capabilities: {
    canManageSettings: true,
    canManageUsers: true,
    canPermanentlyDelete: true,
    canViewFinancialTotals: true,
    canExportData: true,
  },
  accountId: "default",
};

/** Member WITHOUT canManageSettings — used for the capability-denial case. */
const MEMBER: AuthContext = {
  userId: "u-member",
  role: "member",
  capabilities: {
    canManageSettings: false,
    canManageUsers: false,
    canPermanentlyDelete: false,
    canViewFinancialTotals: false,
    canExportData: false,
  },
  accountId: "default",
};

/** Member WITH canManageSettings — proves the gate keys on the capability, not the role. */
const MEMBER_MANAGER: AuthContext = {
  ...MEMBER,
  userId: "u-manager",
  capabilities: { ...MEMBER.capabilities, canManageSettings: true },
};

const nowIso = () => new Date().toISOString();

/**
 * In-memory SettingsRepository. Extends the real class (constructor fields are
 * private, so a structural fake won't satisfy the type) and overrides every
 * public method against Maps — mirroring clients' FakeClientRepository.
 */
class FakeSettingsRepository extends SettingsRepository {
  readonly singletons = new Map<SettingsKey, SettingsDoc>();
  readonly users = new Map<string, UserSettingsDoc>();
  private seq = 0;

  constructor() {
    super(undefined as unknown as Collection<SettingsDoc>, undefined as unknown as Collection<UserSettingsDoc>);
  }

  override async getOrCreate<K extends SettingsKey>(
    _ctx: AuthContext,
    key: K,
    defaults: SettingsDataByKey[K],
  ): Promise<SettingsDoc> {
    const existing = this.singletons.get(key);
    if (existing) return existing;
    const ts = nowIso();
    const doc = {
      key,
      data: defaults,
      id: `s-${++this.seq}`,
      version: 1,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      deletedAt: null,
    } as unknown as SettingsDoc;
    this.singletons.set(key, doc);
    return doc;
  }

  override async updateData<K extends SettingsKey>(
    _ctx: AuthContext,
    key: K,
    current: SettingsDataByKey[K],
    patch: Partial<SettingsDataByKey[K]>,
  ): Promise<SettingsDoc> {
    const existing = this.singletons.get(key)!;
    const next = {
      ...existing,
      data: { ...current, ...patch },
      version: existing.version + 1,
      updatedAt: nowIso(),
    } as SettingsDoc;
    this.singletons.set(key, next);
    return next;
  }

  override async getOrCreateUser(
    _ctx: AuthContext,
    userId: string,
    defaults: UserSettingsData,
  ): Promise<UserSettingsDoc> {
    const existing = this.users.get(userId);
    if (existing) return existing;
    const ts = nowIso();
    const doc: UserSettingsDoc = { userId, ...defaults, createdAt: ts, updatedAt: ts };
    this.users.set(userId, doc);
    return doc;
  }

  override async updateUser(
    _ctx: AuthContext,
    userId: string,
    current: UserSettingsData,
    patch: Partial<UserSettingsData>,
  ): Promise<UserSettingsDoc> {
    const existing = this.users.get(userId)!;
    const next: UserSettingsDoc = {
      ...existing,
      ...current,
      ...patch,
      userId,
      updatedAt: nowIso(),
    };
    this.users.set(userId, next);
    return next;
  }
}

const TEST_ENCRYPTION_KEY = "settings-test-data-encryption-key-32-bytes-ok";

const newService = () => {
  const repo = new FakeSettingsRepository();
  const { emitter, events } = newEmitter();
  const svc = new SettingsService({ repo, emitter, logger, encryptionKey: TEST_ENCRYPTION_KEY });
  return { repo, svc, events };
};

// ── Schema validation ────────────────────────────────────────────────────────

describe("settings schemas — PATCH validation", () => {
  it("business: rejects a malformed currency, accepts a valid partial patch", () => {
    expect(BusinessSettingsUpdateSchema.safeParse({ defaultCurrency: "euro" }).success).toBe(false);
    expect(BusinessSettingsUpdateSchema.safeParse({ defaultCurrency: "USD" }).success).toBe(true);
    // empty patch is valid (partial) — no field is required on PATCH
    expect(BusinessSettingsUpdateSchema.safeParse({}).success).toBe(true);
  });

  it("business: rejects an out-of-range tax rate and an invalid language enum", () => {
    expect(BusinessSettingsUpdateSchema.safeParse({ defaultTaxRate: 150 }).success).toBe(false);
    expect(BusinessSettingsUpdateSchema.safeParse({ defaultLanguage: "xx" }).success).toBe(false);
  });

  it("numbering: rejects padding out of bounds, accepts a valid series", () => {
    const bad = NumberingSettingsUpdateSchema.safeParse({
      invoice: { prefix: "INV-", startNumber: 1, padding: 99, yearlyReset: true },
    });
    expect(bad.success).toBe(false);
    const ok = NumberingSettingsUpdateSchema.safeParse({
      invoice: { prefix: "INV-", startNumber: 1, padding: 4, yearlyReset: true },
    });
    expect(ok.success).toBe(true);
  });

  it("tax: rejects a rate above 100, accepts a valid rate list", () => {
    expect(
      TaxSettingsUpdateSchema.safeParse({ rates: [{ id: "x", label: "X", rate: 200 }] }).success,
    ).toBe(false);
    expect(
      TaxSettingsUpdateSchema.safeParse({
        rates: [{ id: "std", label: "Standard", rate: 22, isDefault: true }],
        pricesIncludeTax: true,
      }).success,
    ).toBe(true);
  });

  it("user settings: rejects an invalid theme/density enum, accepts valid prefs", () => {
    expect(UserSettingsUpdateSchema.safeParse({ theme: "neon" }).success).toBe(false);
    expect(UserSettingsUpdateSchema.safeParse({ density: "roomy" }).success).toBe(false);
    expect(UserSettingsUpdateSchema.safeParse({ theme: "dark", density: "compact" }).success).toBe(true);
  });
});

// ── Per-user settings: default creation + self-scoping ───────────────────────

describe("per-user /me/settings", () => {
  it("GET auto-creates defaults on first access", async () => {
    const { svc, repo } = newService();
    const doc = await svc.getUserSettings(MEMBER);
    expect(doc.userId).toBe(MEMBER.userId);
    expect(doc.theme).toBe(DEFAULT_USER_SETTINGS.theme);
    expect(doc.density).toBe(DEFAULT_USER_SETTINGS.density);
    expect(doc.tables).toEqual({});
    expect(repo.users.get(MEMBER.userId)).toBeTruthy();
  });

  it("PATCH updates the caller's own doc and emits userSettings.updated", async () => {
    const { svc, repo, events } = newService();
    const updated = await svc.updateUserSettings(
      MEMBER,
      UserSettingsUpdateSchema.parse({ theme: "dark", density: "compact" }),
    );
    expect(updated.theme).toBe("dark");
    expect(updated.density).toBe("compact");
    expect(updated.userId).toBe(MEMBER.userId);
    expect(events.map((e) => e.name)).toContain("userSettings.updated");
    expect(repo.users.get(MEMBER.userId)!.theme).toBe("dark");
  });

  it("is self-scoped: a second user gets its own independent doc", async () => {
    const { svc } = newService();
    await svc.updateUserSettings(MEMBER, { theme: "dark" });
    const adminDoc = await svc.getUserSettings(ADMIN);
    // ADMIN never touched theme → still the default, unaffected by MEMBER's write.
    expect(adminDoc.theme).toBe(DEFAULT_USER_SETTINGS.theme);
    expect(adminDoc.userId).toBe(ADMIN.userId);
  });

  it("requires no capability — a plain member may read and write", async () => {
    const { svc } = newService();
    await expect(svc.getUserSettings(MEMBER)).resolves.toBeTruthy();
    await expect(svc.updateUserSettings(MEMBER, { theme: "light" })).resolves.toBeTruthy();
  });
});

// ── Global settings: default creation + capability gate ──────────────────────

describe("global settings — get-or-create defaults", () => {
  it("GET business/tax/numbering auto-create their defaults on first access", async () => {
    const { svc } = newService();
    const business = await svc.getBusiness(ADMIN);
    const tax = await svc.getTax(ADMIN);
    const numbering = await svc.getNumbering(ADMIN);
    expect(business.key).toBe("business");
    expect(business.data).toEqual(DEFAULT_BUSINESS_SETTINGS);
    expect(tax.data).toEqual(DEFAULT_TAX_SETTINGS);
    expect(numbering.data).toEqual(DEFAULT_NUMBERING_SETTINGS);
  });

  it("a member may READ global settings (get is not gated)", async () => {
    const { svc } = newService();
    await expect(svc.getBusiness(MEMBER)).resolves.toBeTruthy();
    await expect(svc.getTax(MEMBER)).resolves.toBeTruthy();
    await expect(svc.getNumbering(MEMBER)).resolves.toBeTruthy();
  });
});

describe("global settings — canManageSettings gate on write", () => {
  it("admin PATCH business succeeds, merges the patch, bumps version, emits", async () => {
    const { svc, events } = newService();
    const updated = await svc.updateBusiness(ADMIN, { businessName: "Acme SpA", defaultCurrency: "USD" });
    expect(updated.data.businessName).toBe("Acme SpA");
    expect(updated.data.defaultCurrency).toBe("USD");
    // unpatched default field preserved by the merge
    expect(updated.data.timezone).toBe(DEFAULT_BUSINESS_SETTINGS.timezone);
    expect(updated.version).toBe(2);
    expect(events.map((e) => e.name)).toContain("settings.business.updated");
  });

  it("a member WITHOUT canManageSettings → CAPABILITY_DENIED on every global write", async () => {
    const { svc, repo } = newService();
    await expect(svc.updateBusiness(MEMBER, { businessName: "Nope" })).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    });
    await expect(svc.updateTax(MEMBER, { pricesIncludeTax: true })).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    });
    await expect(
      svc.updateNumbering(MEMBER, {
        invoice: { prefix: "X-", startNumber: 1, padding: 3, yearlyReset: false },
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    // nothing persisted
    expect(repo.singletons.get("business")).toBeUndefined();
  });

  it("a member WITH canManageSettings may write (gate keys on the capability, not role)", async () => {
    const { svc } = newService();
    const updated = await svc.updateTax(MEMBER_MANAGER, { pricesIncludeTax: true });
    expect(updated.data.pricesIncludeTax).toBe(true);
  });
});

// ── Customization schemas (CUST-1) ───────────────────────────────────────────

describe("customization schemas — PATCH validation", () => {
  it("branding: rejects a malformed hex color, accepts a valid partial patch", () => {
    expect(BrandingSettingsUpdateSchema.safeParse({ primaryColor: "blue" }).success).toBe(false);
    expect(BrandingSettingsUpdateSchema.safeParse({ primaryColor: "#1867C0" }).success).toBe(true);
    expect(BrandingSettingsUpdateSchema.safeParse({ defaultThemeMode: "neon" }).success).toBe(false);
  });

  it("localization: rejects a bad currency / firstDayOfWeek out of range", () => {
    expect(LocalizationSettingsUpdateSchema.safeParse({ defaultCurrency: "eur" }).success).toBe(false);
    expect(LocalizationSettingsUpdateSchema.safeParse({ firstDayOfWeek: 9 }).success).toBe(false);
    expect(
      LocalizationSettingsUpdateSchema.safeParse({ defaultCurrency: "USD", firstDayOfWeek: 0 }).success,
    ).toBe(true);
  });

  it("email: accepts smtpPassword as write-only input, rejects a bad port", () => {
    expect(EmailSettingsUpdateSchema.safeParse({ smtpPort: 99999 }).success).toBe(false);
    expect(EmailSettingsUpdateSchema.safeParse({ smtpPassword: "s3cret" }).success).toBe(true);
    // smtpPasswordEnc is NOT an accepted input key (write raw ciphertext is impossible);
    // unknown keys are stripped by the object schema, so parsing still succeeds but drops it.
    const parsed = EmailSettingsUpdateSchema.parse({ smtpPasswordEnc: "v1:a:b:c" } as never);
    expect("smtpPasswordEnc" in parsed).toBe(false);
  });
});

// ── Customization: get-or-create + capability gate on write ──────────────────

describe("customization groups — get-or-create + canManageSettings gate", () => {
  it("GET branding/localization/documents/toggles auto-create defaults", async () => {
    const { svc } = newService();
    expect((await svc.getBranding(ADMIN)).data.appName).toBe("Billy");
    expect((await svc.getLocalization(ADMIN)).data.defaultCurrency).toBe("EUR");
    expect((await svc.getDocuments(ADMIN)).data.pdfTemplate).toBe("default");
    expect((await svc.getToggles(ADMIN)).data.require2fa).toBe("off");
  });

  it("admin PATCH branding merges + emits; member WITHOUT capability is denied", async () => {
    const { svc, events } = newService();
    const updated = await svc.updateBranding(ADMIN, { appName: "Acme", primaryColor: "#FF0000" });
    expect(updated.data.appName).toBe("Acme");
    expect(updated.data.primaryColor).toBe("#FF0000");
    expect(events.map((e) => e.name)).toContain("settings.branding.updated");

    await expect(svc.updateBranding(MEMBER, { appName: "Nope" })).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    });
    await expect(svc.updateLocalization(MEMBER, { timezone: "UTC" })).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    });
  });
});

// ── Customization: SMTP password write-only + field-encrypted (CUST-2) ───────

describe("email settings — SMTP password is write-only and field-encrypted", () => {
  it("GET email never returns the password; reports smtpConfigured instead", async () => {
    const { svc } = newService();
    const view = await svc.getEmail(ADMIN);
    // No secret fields on the view at all.
    expect("smtpPasswordEnc" in view).toBe(false);
    expect("smtpPassword" in view).toBe(false);
    // Nothing set yet.
    expect(view.smtpConfigured).toBe(false);
  });

  it("PATCH with smtpPassword → GET returns smtpConfigured:true, never the value", async () => {
    const { svc, repo } = newService();
    const afterPatch = await svc.updateEmail(ADMIN, {
      smtpHost: "smtp.example.com",
      smtpUsername: "mailer",
      smtpPassword: "super-secret",
    });
    // PATCH response is the secret-free view.
    expect(afterPatch.smtpConfigured).toBe(true);
    expect("smtpPasswordEnc" in afterPatch).toBe(false);
    expect(JSON.stringify(afterPatch).includes("super-secret")).toBe(false);

    const view = await svc.getEmail(ADMIN);
    expect(view.smtpConfigured).toBe(true);
    expect(view.smtpHost).toBe("smtp.example.com");
    expect(JSON.stringify(view).includes("super-secret")).toBe(false);

    // The stored doc holds ciphertext (never plaintext) and it decrypts back.
    const stored = repo.singletons.get("email");
    const enc = (stored?.data as { smtpPasswordEnc?: string }).smtpPasswordEnc;
    expect(typeof enc).toBe("string");
    expect(enc!.startsWith("v1:")).toBe(true);
    expect(enc!.includes("super-secret")).toBe(false);
    expect(decryptField(enc!, TEST_ENCRYPTION_KEY)).toBe("super-secret");
  });

  it("PATCH email without a password leaves the existing secret intact", async () => {
    const { svc, repo } = newService();
    await svc.updateEmail(ADMIN, { smtpPassword: "keep-me" });
    await svc.updateEmail(ADMIN, { smtpHost: "smtp.example.com" }); // no password field
    const enc = (repo.singletons.get("email")?.data as { smtpPasswordEnc?: string }).smtpPasswordEnc;
    expect(decryptField(enc!, TEST_ENCRYPTION_KEY)).toBe("keep-me");
    expect((await svc.getEmail(ADMIN)).smtpConfigured).toBe(true);
  });

  it("PATCH email with smtpPassword:null clears the stored secret", async () => {
    const { svc } = newService();
    await svc.updateEmail(ADMIN, { smtpPassword: "temp" });
    const cleared = await svc.updateEmail(ADMIN, { smtpPassword: null });
    expect(cleared.smtpConfigured).toBe(false);
  });

  it("a member WITHOUT canManageSettings cannot write email settings", async () => {
    const { svc, repo } = newService();
    await expect(svc.updateEmail(MEMBER, { smtpPassword: "x" })).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    });
    expect(repo.singletons.get("email")).toBeUndefined();
  });

  it("test-send uses jsonTransport when no host is set (dev feedback)", async () => {
    const { svc } = newService();
    const result = await svc.testEmail(ADMIN);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("json");
  });

  it("test-send requires canManageSettings", async () => {
    const { svc } = newService();
    await expect(svc.testEmail(MEMBER)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
  });
});
