/**
 * Account store. Sysadmin-only: lists all accounts and assumes one as the
 * session's active account. Normal users never call these (the switcher is
 * hidden and `fetchAccounts` no-ops when the principal is not a sysadmin).
 *
 *   GET  /v1/accounts            → all accounts (sysadmin only)
 *   POST /v1/auth/assume-account → set the session's active account, re-resolve
 *
 * Assuming an account changes global scope (branding, settings, notifications,
 * every cached list), so after a successful switch we hard-reload the page to
 * re-resolve every store cleanly rather than only refreshing the principal.
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import { api } from "@/api/client";
import { useAuthStore } from "@/stores/auth";

/** An account row as returned by GET /v1/accounts (sysadmin list). */
export interface Account {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export const useAccountStore = defineStore("account", () => {
  const accounts = ref<Account[]>([]);
  const loading = ref<boolean>(false);

  /** Load the account list. No-op for non-sysadmins and when already loaded. */
  async function fetchAccounts(): Promise<void> {
    const auth = useAuthStore();
    if (!auth.principal?.isSysadmin) return;
    if (accounts.value.length > 0 || loading.value) return;
    loading.value = true;
    try {
      const { data } = await api.list<Account>("/v1/accounts");
      accounts.value = data;
    } finally {
      loading.value = false;
    }
  }

  /**
   * Assume `accountId` as the session's active account. On success the whole app
   * re-resolves under the new scope via a hard reload (scope changes are global).
   */
  async function assumeAccount(accountId: string): Promise<void> {
    await api.post("/v1/auth/assume-account", { accountId });
    window.location.reload();
  }

  return { accounts, loading, fetchAccounts, assumeAccount };
});
