<script setup lang="ts">
/**
 * Users management tab — admin only (canManageUsers; the panel gates its render).
 * Lists SafeUser[] and supports add / edit (role, caps, status) / reset-password
 * / delete. Surfaces the last-admin FORBIDDEN and DUPLICATE_VALUE errors clearly
 * (a guarded admin cannot be demoted/disabled/deleted below one administrator).
 */
import { ref, onMounted, computed, inject } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import type { Capabilities, Role } from "@billy/types";
import type { SafeUser } from "@/types/domain";
import { useFieldErrors } from "@/pages/settings/useFieldErrors";
import { SNACKBAR_KEY, NOOP_NOTIFY } from "@/pages/settings/snackbar";
import { confirm } from "@/composables/useConfirm";

const { t } = useI18n();
const notify = inject(SNACKBAR_KEY, NOOP_NOTIFY);
const { fieldErrors, applyError, clear } = useFieldErrors();

const users = ref<SafeUser[]>([]);
const loading = ref(false);
const listError = ref<string | null>(null);

const roleOptions = computed(() => [
  { title: t("users.roles.administrator"), value: "administrator" as Role },
  { title: t("users.roles.member"), value: "member" as Role },
]);

const load = async (): Promise<void> => {
  loading.value = true;
  listError.value = null;
  try {
    users.value = await api.get<SafeUser[]>("/v1/users");
  } catch (err) {
    listError.value = err instanceof ApiError ? `${t("users.loadError")} (${err.code})` : t("users.loadError");
  } finally {
    loading.value = false;
  }
};

// ── Create / edit dialog ───────────────────────────────────────────────────────
const dialog = ref(false);
const editing = ref<SafeUser | null>(null);
const saving = ref(false);
const formError = ref<string | null>(null);
const showFormPassword = ref(false);
const form = ref({
  email: "",
  displayName: "",
  role: "member" as Role,
  password: "",
  status: "active" as SafeUser["status"],
  capabilities: {
    canManageSettings: false,
    canManageUsers: false,
    canPermanentlyDelete: false,
    canViewFinancialTotals: false,
    canExportData: false,
  } as Capabilities,
});

const isEdit = computed(() => editing.value !== null);

const capKeys: (keyof Capabilities)[] = [
  "canManageSettings",
  "canManageUsers",
  "canPermanentlyDelete",
  "canViewFinancialTotals",
  "canExportData",
];

const openCreate = (): void => {
  clear();
  editing.value = null;
  formError.value = null;
  form.value = {
    email: "",
    displayName: "",
    role: "member",
    password: "",
    status: "active",
    capabilities: {
      canManageSettings: false,
      canManageUsers: false,
      canPermanentlyDelete: false,
      canViewFinancialTotals: false,
      canExportData: false,
    },
  };
  dialog.value = true;
};

const openEdit = (u: SafeUser): void => {
  clear();
  editing.value = u;
  formError.value = null;
  form.value = {
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    password: "",
    status: u.status,
    capabilities: { ...u.capabilities },
  };
  dialog.value = true;
};

const messageForWrite = (err: unknown): string => {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "DUPLICATE_VALUE":
        return t("users.errors.duplicate");
      case "FORBIDDEN":
        return t("users.errors.lastAdmin");
      case "CAPABILITY_DENIED":
        return t("users.errors.capabilityDenied");
      default:
        return `${t("users.errors.generic")} (${err.code})`;
    }
  }
  return t("users.errors.generic");
};

const save = async (): Promise<void> => {
  clear();
  formError.value = null;
  saving.value = true;
  try {
    if (isEdit.value && editing.value) {
      const updated = await api.patch<SafeUser>(`/v1/users/${editing.value.id}`, {
        displayName: form.value.displayName,
        role: form.value.role,
        capabilities: form.value.capabilities,
        status: form.value.status,
      });
      const idx = users.value.findIndex((u) => u.id === updated.id);
      if (idx >= 0) users.value[idx] = updated;
      notify(t("users.savedEdit"));
    } else {
      const created = await api.post<SafeUser>("/v1/users", {
        email: form.value.email,
        displayName: form.value.displayName,
        role: form.value.role,
        password: form.value.password,
        capabilities: form.value.capabilities,
      });
      users.value.push(created);
      notify(t("users.savedCreate"));
    }
    dialog.value = false;
  } catch (err) {
    applyError(err);
    formError.value = messageForWrite(err);
  } finally {
    saving.value = false;
  }
};

// ── Reset password dialog ──────────────────────────────────────────────────────
const resetDialog = ref(false);
const resetTarget = ref<SafeUser | null>(null);
const resetPassword = ref("");
const showResetPassword = ref(false);
const resetting = ref(false);
const resetError = ref<string | null>(null);

const openReset = (u: SafeUser): void => {
  resetTarget.value = u;
  resetPassword.value = "";
  resetError.value = null;
  resetDialog.value = true;
};

const doReset = async (): Promise<void> => {
  if (!resetTarget.value) return;
  resetError.value = null;
  if (resetPassword.value.length < 8) {
    resetError.value = t("users.reset.tooShort");
    return;
  }
  resetting.value = true;
  try {
    const updated = await api.post<SafeUser>(`/v1/users/${resetTarget.value.id}/reset-password`, {
      password: resetPassword.value,
    });
    const idx = users.value.findIndex((u) => u.id === updated.id);
    if (idx >= 0) users.value[idx] = updated;
    resetDialog.value = false;
    notify(t("users.reset.done"));
  } catch (err) {
    resetError.value = messageForWrite(err);
  } finally {
    resetting.value = false;
  }
};

// ── Disable / delete ───────────────────────────────────────────────────────────
const toggleStatus = async (u: SafeUser): Promise<void> => {
  const next: SafeUser["status"] = u.status === "active" ? "disabled" : "active";
  try {
    const updated = await api.patch<SafeUser>(`/v1/users/${u.id}`, { status: next });
    const idx = users.value.findIndex((x) => x.id === updated.id);
    if (idx >= 0) users.value[idx] = updated;
    notify(next === "disabled" ? t("users.disabledToast") : t("users.enabledToast"));
  } catch (err) {
    listError.value = messageForWrite(err);
  }
};

const remove = async (u: SafeUser): Promise<void> => {
  const ok = await confirm({
    title: t("users.delete.title"),
    message: t("users.delete.message", { name: u.displayName || u.email }),
    confirmText: t("users.delete.confirm"),
    tone: "error",
  });
  if (!ok) return;
  try {
    await api.del<{ deleted: true }>(`/v1/users/${u.id}`);
    users.value = users.value.filter((x) => x.id !== u.id);
    notify(t("users.deletedToast"));
  } catch (err) {
    listError.value = messageForWrite(err);
  }
};

onMounted(() => {
  void load();
});
</script>

<template>
  <v-card variant="outlined" rounded="lg">
    <v-card-text>
    <div class="d-flex align-center mb-4">
      <div>
        <div class="text-subtitle-1 font-weight-medium">{{ t("users.title") }}</div>
        <div class="text-caption text-medium-emphasis">{{ t("users.hint") }}</div>
      </div>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-account-plus-outline" @click="openCreate">
        {{ t("users.add") }}
      </v-btn>
    </div>

    <v-alert v-if="listError" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ listError }}
    </v-alert>

    <div v-if="loading" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </div>

    <v-table v-else density="comfortable">
      <thead>
        <tr>
          <th>{{ t("users.columns.name") }}</th>
          <th>{{ t("users.columns.email") }}</th>
          <th>{{ t("users.columns.role") }}</th>
          <th>{{ t("users.columns.status") }}</th>
          <th>{{ t("users.columns.twoFactor") }}</th>
          <th class="text-right">{{ t("users.columns.actions") }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="u in users" :key="u.id">
          <td>{{ u.displayName }}</td>
          <td>{{ u.email }}</td>
          <td>
            <v-chip size="small" variant="tonal" :color="u.role === 'administrator' ? 'primary' : undefined">
              {{ t(`users.roles.${u.role}`) }}
            </v-chip>
          </td>
          <td>
            <v-chip size="small" variant="tonal" :color="u.status === 'active' ? 'success' : 'error'">
              {{ t(`users.status.${u.status}`) }}
            </v-chip>
          </td>
          <td>
            <v-icon v-if="u.totpEnabled" color="success" icon="mdi-shield-check" :aria-label="t('users.twoFactorOn')" />
            <span v-else class="text-medium-emphasis">—</span>
          </td>
          <td class="text-right">
            <v-menu>
              <template #activator="{ props }">
                <v-btn icon="mdi-dots-vertical" variant="text" size="small" v-bind="props" :aria-label="t('users.columns.actions')" />
              </template>
              <v-list density="compact">
                <v-list-item prepend-icon="mdi-pencil-outline" :title="t('common.edit')" @click="openEdit(u)" />
                <v-list-item prepend-icon="mdi-lock-reset" :title="t('users.reset.action')" @click="openReset(u)" />
                <v-list-item
                  :prepend-icon="u.status === 'active' ? 'mdi-account-off-outline' : 'mdi-account-check-outline'"
                  :title="u.status === 'active' ? t('users.disable') : t('users.enable')"
                  @click="toggleStatus(u)"
                />
                <v-list-item prepend-icon="mdi-delete-outline" :title="t('users.delete.action')" base-color="error" @click="remove(u)" />
              </v-list>
            </v-menu>
          </td>
        </tr>
        <tr v-if="users.length === 0">
          <td colspan="6" class="text-center text-medium-emphasis pa-6">{{ t("users.empty") }}</td>
        </tr>
      </tbody>
    </v-table>
    </v-card-text>

    <!-- Create / edit dialog -->
    <v-dialog v-model="dialog" max-width="560">
      <v-card>
        <v-card-title>{{ isEdit ? t("users.editTitle") : t("users.addTitle") }}</v-card-title>
        <v-card-text>
          <v-alert v-if="formError" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
            {{ formError }}
          </v-alert>
          <v-text-field
            v-model="form.email"
            :label="t('users.fields.email')"
            :error-messages="fieldErrors.email"
            :disabled="isEdit"
            type="email"
            density="comfortable"
          />
          <v-text-field
            v-model="form.displayName"
            :label="t('users.fields.displayName')"
            :error-messages="fieldErrors.displayName"
            density="comfortable"
          />
          <v-select
            v-model="form.role"
            :items="roleOptions"
            :label="t('users.fields.role')"
            :error-messages="fieldErrors.role"
            density="comfortable"
          />
          <v-text-field
            v-if="!isEdit"
            v-model="form.password"
            :label="t('users.fields.password')"
            :error-messages="fieldErrors.password"
            :hint="t('users.fields.passwordHint')"
            persistent-hint
            :type="showFormPassword ? 'text' : 'password'"
            :append-inner-icon="showFormPassword ? 'mdi-eye-off' : 'mdi-eye'"
            autocomplete="new-password"
            density="comfortable"
            @click:append-inner="showFormPassword = !showFormPassword"
          />
          <v-select
            v-if="isEdit"
            v-model="form.status"
            :items="[
              { title: t('users.status.active'), value: 'active' },
              { title: t('users.status.disabled'), value: 'disabled' },
            ]"
            :label="t('users.fields.status')"
            density="comfortable"
          />

          <div class="text-subtitle-2 font-weight-medium mt-2 mb-1">{{ t("users.fields.capabilities") }}</div>
          <v-switch
            v-for="cap in capKeys"
            :key="cap"
            v-model="form.capabilities[cap]"
            :label="t(`users.capabilities.${cap}`)"
            density="compact"
            color="primary"
            hide-details
          />
        </v-card-text>
        <v-card-actions>
          <v-btn variant="text" :disabled="saving" @click="dialog = false">{{ t("common.cancel") }}</v-btn>
          <v-spacer />
          <v-btn color="primary" variant="flat" :loading="saving" @click="save">{{ t("common.saveChanges") }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Reset password dialog -->
    <v-dialog v-model="resetDialog" max-width="440">
      <v-card>
        <v-card-title>{{ t("users.reset.title") }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 text-medium-emphasis mb-4">
            {{ t("users.reset.hint", { name: resetTarget?.displayName || resetTarget?.email || "" }) }}
          </p>
          <v-alert v-if="resetError" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
            {{ resetError }}
          </v-alert>
          <v-text-field
            v-model="resetPassword"
            :label="t('users.reset.newPassword')"
            :hint="t('users.fields.passwordHint')"
            persistent-hint
            :type="showResetPassword ? 'text' : 'password'"
            :append-inner-icon="showResetPassword ? 'mdi-eye-off' : 'mdi-eye'"
            autocomplete="new-password"
            density="comfortable"
            autofocus
            @click:append-inner="showResetPassword = !showResetPassword"
          />
        </v-card-text>
        <v-card-actions>
          <v-btn variant="text" :disabled="resetting" @click="resetDialog = false">{{ t("common.cancel") }}</v-btn>
          <v-spacer />
          <v-btn color="primary" variant="flat" :loading="resetting" @click="doReset">{{ t("users.reset.action") }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>
