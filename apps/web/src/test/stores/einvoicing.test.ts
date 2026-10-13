import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as apiClient from "@/api/client";
import { ApiError } from "@/api/client";
import { useAuthStore } from "@/stores/auth";
import { useEInvoicing } from "@/stores/einvoicing";
import { settingsView } from "@/test/helpers/einvoicing";
import type { Capabilities } from "@billy/types";

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  canManageSettings: false,
  canManageUsers: false,
  canPermanentlyDelete: false,
  canViewFinancialTotals: false,
  canExportData: false,
  ...over,
});

const signIn = (capabilities: Capabilities): void => {
  useAuthStore().principal = { userId: "u1", role: "member", capabilities, accountId: "a" };
};

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => vi.restoreAllMocks());

describe("useEInvoicing store", () => {
  it("admins read the full settings view", async () => {
    signIn(caps({ canManageSettings: true }));
    const get = vi.spyOn(apiClient.api, "get").mockResolvedValue(settingsView({ enabled: true, scheduledDefaultSubmit: true }));
    const s = useEInvoicing();
    await s.load();
    expect(get).toHaveBeenCalledWith("/v1/settings/einvoicing");
    expect(s.enabled).toBe(true);
    expect(s.scheduledDefaultSubmit).toBe(true);
  });

  it("non-admins use the summary `enabled` flag and never touch the settings route", async () => {
    signIn(caps());
    const get = vi.spyOn(apiClient.api, "get").mockResolvedValue({ enabled: true, notSent: 0, overdue: 0, items: [] });
    const s = useEInvoicing();
    await s.load();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/v1/einvoicing/summary");
    expect(s.enabled).toBe(true);
    // No hints from the server → sensible defaults: offer the step, opt-ins off.
    expect(s.offerStepAfterFinalize).toBe(true);
    expect(s.scheduledDefaultSubmit).toBe(false);
    expect(s.recurringDefaultSubmit).toBe(false);
  });

  it("an admin who gets 403 falls back to the summary", async () => {
    signIn(caps({ canManageSettings: true }));
    const get = vi.spyOn(apiClient.api, "get").mockImplementation(async (path: string) => {
      if (path === "/v1/settings/einvoicing") throw new ApiError("FORBIDDEN", "no", 403);
      return { enabled: true, notSent: 2, overdue: 0, items: [] };
    });
    const s = useEInvoicing();
    await s.load();
    expect(get).toHaveBeenCalledTimes(2);
    expect(s.enabled).toBe(true);
  });

  it("any failure resolves to disabled, loads once, and force re-fetches", async () => {
    signIn(caps());
    const get = vi.spyOn(apiClient.api, "get").mockRejectedValue(new ApiError("INTERNAL_ERROR", "x", 500));
    const s = useEInvoicing();
    await Promise.all([s.load(), s.load()]);
    await s.load();
    expect(get).toHaveBeenCalledTimes(1);
    expect(s.enabled).toBe(false);
    await s.load(true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("applyView (from the settings tab) updates everyone immediately", () => {
    const s = useEInvoicing();
    expect(s.enabled).toBe(false);
    s.applyView(settingsView({ enabled: true }));
    expect(s.enabled).toBe(true);
  });
});
