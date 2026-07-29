/**
 * Auth store. Cookie-session auth: the browser holds the session cookie;
 * the store holds the resolved principal. Talks to the backend auth routes via
 * the api client (envelope-unwrapping, credentials: include).
 *
 *   POST /auth/login   → sets session cookie, returns principal
 *   POST /auth/logout  → clears session
 *   GET  /auth/me      → current principal (used to resolve session on boot)
 */
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { api, ApiError } from "@/api/client";
import type { LoginResult, Principal } from "@/types/domain";

export interface LoginCredentials {
  email: string;
  password: string;
}

/** Strip the `status` discriminator off an authenticated payload → Principal. */
const toPrincipal = (data: { status: "authenticated" } & Principal): Principal => {
  const { status: _status, ...principal } = data;
  return principal;
};

export const useAuthStore = defineStore("auth", () => {
  const principal = ref<Principal | null>(null);
  /** True until the first `fetchMe` resolves — the guard awaits this on boot. */
  const resolving = ref<boolean>(true);

  const isAuthenticated = computed<boolean>(() => principal.value !== null);

  /**
   * Step 1 of login. Returns the raw discriminated result so the Login page can
   * branch: on `authenticated` the principal is already set here; on
   * `2fa_required` NO principal is set (no cookie yet) and the caller must
   * complete via `verifyTwoFactor` with the returned `pendingToken`.
   */
  async function login(credentials: LoginCredentials): Promise<LoginResult> {
    const result = await api.post<LoginResult>("/v1/auth/login", credentials);
    if (result.status === "authenticated") {
      principal.value = toPrincipal(result);
    }
    return result;
  }

  /**
   * Step 2 of login (only when step 1 returned `2fa_required`). Exchanges the
   * pending token + a TOTP/backup code for an authenticated session, setting the
   * principal just like a normal login.
   */
  async function verifyTwoFactor(pendingToken: string, code: string): Promise<Principal> {
    const result = await api.post<{ status: "authenticated" } & Principal>(
      "/v1/auth/login/verify-2fa",
      { pendingToken, code },
    );
    const p = toPrincipal(result);
    principal.value = p;
    return p;
  }

  async function logout(): Promise<void> {
    try {
      await api.post<null>("/v1/auth/logout");
    } finally {
      principal.value = null;
    }
  }

  /**
   * Clear the local session WITHOUT calling the API. Used by the global
   * auto-logout hook when a request already came back 401/UNAUTHENTICATED — the
   * server session is gone, so there's nothing to POST /logout for (and doing so
   * would just 401 again).
   */
  function clearSession(): void {
    principal.value = null;
  }

  /**
   * Resolve the current session. Swallows the expected 401 (no/expired session)
   * into `principal = null`; rethrows anything unexpected.
   */
  async function fetchMe(): Promise<Principal | null> {
    resolving.value = true;
    try {
      const p = await api.get<Principal>("/v1/auth/me");
      principal.value = p;
      return p;
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.code === "UNAUTHENTICATED" ||
          err.code === "SESSION_EXPIRED" ||
          err.code === "SESSION_REVOKED")
      ) {
        principal.value = null;
        return null;
      }
      throw err;
    } finally {
      resolving.value = false;
    }
  }

  /** Clear the mustChangePassword flag locally after a successful change. */
  function clearMustChangePassword(): void {
    if (principal.value) principal.value = { ...principal.value, mustChangePassword: false };
  }

  return {
    principal,
    resolving,
    isAuthenticated,
    login,
    verifyTwoFactor,
    logout,
    clearSession,
    clearMustChangePassword,
    fetchMe,
  };
});
