<script setup lang="ts">
/**
 * Sysadmin-only account management. Lists all accounts and supports create
 * (+ optional first administrator), edit, and the SECURE MULTI-STEP destructive
 * delete (warning → type the exact account name → sysadmin password). Guarded on
 * the principal's isSysadmin; every /accounts endpoint is also server-side
 * sysadmin-gated (defence in depth).
 */
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import { useAuthStore } from "@/stores/auth";
import { useToast } from "@/composables/useToast";
import validations from "@/constants/validations";
import { useIsMobile } from "@/composables/useIsMobile";
import PageHeader from "@/components/PageHeader.vue";
import type { VuetifyFormRef } from "@/composables/useFormSubmit";
import { enumLabel } from "@/utils/enums";

interface Account {
  id: string;
  name: string;
  slug: string;
  status: string;
  note?: string | null;
  version: number;
  createdAt: string;
}

const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();
const { toast } = useToast();
const isMobile = useIsMobile();

const isSysadmin = computed<boolean>(() => auth.principal?.isSysadmin === true);

const accounts = ref<Account[]>([]);
const loading = ref(false);

const load = async (): Promise<void> => {
  loading.value = true;
  try {
    const { data } = await api.list<Account>("/v1/accounts");
    accounts.value = data;
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : t("accounts.loadError"));
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  // Non-sysadmins never belong here — bounce to their settings.
  if (!isSysadmin.value) {
    void router.replace({ name: "settings-customization" });
    return;
  }
  void load();
});

// ── Create ───────────────────────────────────────────────────────────────────
const createOpen = ref(false);
const createFormRef = ref<VuetifyFormRef | null>(null);
const cName = ref("");
const cSlug = ref("");
const cNote = ref("");
const withAdmin = ref(false);
const aEmail = ref("");
const aName = ref("");
const aPassword = ref("");
const showAPassword = ref(false);
const creating = ref(false);

const openCreate = (): void => {
  cName.value = "";
  cSlug.value = "";
  cNote.value = "";
  withAdmin.value = false;
  aEmail.value = "";
  aName.value = "";
  aPassword.value = "";
  createFormRef.value?.resetValidation?.();
  createOpen.value = true;
};

const submitCreate = async (): Promise<void> => {
  if (createFormRef.value && !(await createFormRef.value.validate()).valid) return;
  creating.value = true;
  try {
    const body: Record<string, unknown> = { name: cName.value.trim() };
    if (cSlug.value.trim()) body.slug = cSlug.value.trim();
    if (cNote.value.trim()) body.note = cNote.value.trim();
    if (withAdmin.value) {
      body.admin = { email: aEmail.value.trim(), displayName: aName.value.trim(), password: aPassword.value };
    }
    await api.post("/v1/accounts", body);
    toast.success(t("accounts.created"));
    createOpen.value = false;
    await load();
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : t("accounts.saveError"));
  } finally {
    creating.value = false;
  }
};

// ── Edit ─────────────────────────────────────────────────────────────────────
const editOpen = ref(false);
const editing = ref<Account | null>(null);
const eName = ref("");
const eNote = ref("");
const eStatus = ref("active");
const saving = ref(false);
const editFormRef = ref<VuetifyFormRef | null>(null);

/** Account status codes → translated labels (chips + the edit select). */
const ACCOUNT_STATUSES = ["active", "suspended"] as const;
const statusLabel = (status: string): string => enumLabel(t, "status", status);
const statusItems = computed(() => ACCOUNT_STATUSES.map((value) => ({ title: statusLabel(value), value })));

const openEdit = (acc: Account): void => {
  editing.value = acc;
  eName.value = acc.name;
  eNote.value = acc.note ?? "";
  eStatus.value = acc.status;
  editFormRef.value?.resetValidation?.();
  editOpen.value = true;
};

const submitEdit = async (): Promise<void> => {
  if (!editing.value) return;
  if (editFormRef.value && !(await editFormRef.value.validate()).valid) return;
  saving.value = true;
  try {
    await api.patch(`/v1/accounts/${editing.value.id}`, {
      version: editing.value.version,
      name: eName.value.trim(),
      note: eNote.value.trim() || null,
      status: eStatus.value,
    });
    toast.success(t("accounts.saved"));
    editOpen.value = false;
    await load();
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : t("accounts.saveError"));
  } finally {
    saving.value = false;
  }
};

// ── Secure multi-step DELETE ──────────────────────────────────────────────────
const deleteOpen = ref(false);
const deleteTarget = ref<Account | null>(null);
const deleteStep = ref<1 | 2>(1); // 1 = warning, 2 = confirm name + password
const confirmName = ref("");
const confirmPassword = ref("");
const showConfirmPassword = ref(false);
const deleting = ref(false);

const openDelete = (acc: Account): void => {
  deleteTarget.value = acc;
  deleteStep.value = 1;
  confirmName.value = "";
  confirmPassword.value = "";
  deleteOpen.value = true;
};

/** The confirm button is enabled only when the typed name exactly matches. */
const nameMatches = computed<boolean>(
  () => !!deleteTarget.value && confirmName.value.trim() === deleteTarget.value.name.trim(),
);

const submitDelete = async (): Promise<void> => {
  if (!deleteTarget.value || !nameMatches.value || !confirmPassword.value) return;
  deleting.value = true;
  try {
    await api.post(`/v1/accounts/${deleteTarget.value.id}/delete`, {
      confirmName: confirmName.value.trim(),
      password: confirmPassword.value,
    });
    toast.success(t("accounts.deleted"));
    deleteOpen.value = false;
    await load();
  } catch (err) {
    if (err instanceof ApiError && err.code === "FORBIDDEN") {
      toast.error(t("accounts.delete.wrongPassword"));
    } else if (err instanceof ApiError && err.code === "VALIDATION_FAILED") {
      toast.error(t("accounts.delete.nameMismatch"));
    } else {
      toast.error(err instanceof ApiError ? err.message : t("accounts.saveError"));
    }
  } finally {
    deleting.value = false;
  }
};

const headers = computed(() => [
  { title: t("accounts.columns.name"), key: "name" },
  { title: t("accounts.columns.slug"), key: "slug" },
  { title: t("accounts.columns.status"), key: "status" },
  { title: "", key: "actions", align: "end" as const, sortable: false },
]);
</script>

<template>
  <div v-if="isSysadmin">
    <PageHeader :title="t('accounts.title')" :primary="{ label: t('accounts.new'), icon: 'mdi-plus', onClick: openCreate }" />

    <!-- Phone: one card per account; edit/delete in the overflow menu. -->
    <div v-if="isMobile" class="acc-m" role="list" :aria-label="t('accounts.listTitle')">
      <template v-if="loading && accounts.length === 0">
        <div v-for="n in 3" :key="n" class="acc-m__card">
          <v-skeleton-loader type="list-item-two-line" />
        </div>
      </template>
      <div v-for="item in accounts" :key="item.id" class="acc-m__card" role="listitem">
        <v-avatar color="primary" variant="tonal" rounded="lg" size="40" class="acc-m__avatar">
          <v-icon icon="mdi-office-building-outline" size="20" />
        </v-avatar>
        <div class="acc-m__titles">
          <div class="acc-m__name">{{ item.name }}</div>
          <div class="acc-m__slug">{{ item.slug }}</div>
          <v-chip :color="item.status === 'active' ? 'success' : 'warning'" size="small" variant="tonal" class="mt-2">
            {{ statusLabel(item.status) }}
          </v-chip>
        </div>
        <v-menu location="bottom end">
          <template #activator="{ props }">
            <v-btn icon="mdi-dots-vertical" variant="text" class="acc-m__menu" v-bind="props" :aria-label="t('users.columns.actions')" />
          </template>
          <v-list density="comfortable">
            <v-list-item prepend-icon="mdi-pencil-outline" :title="t('common.edit')" @click="openEdit(item)" />
            <v-list-item prepend-icon="mdi-delete-outline" :title="t('accounts.delete.action')" base-color="error" @click="openDelete(item)" />
          </v-list>
        </v-menu>
      </div>
    </div>

    <v-card v-else variant="flat" border>
      <v-card-title class="text-subtitle-1 font-weight-medium">{{ t("accounts.listTitle") }}</v-card-title>
      <v-card-text>
        <v-data-table :headers="headers" :items="accounts" :loading="loading" density="comfortable">
          <template #[`item.status`]="{ item }">
            <v-chip :color="item.status === 'active' ? 'success' : 'warning'" size="small" variant="tonal">
              {{ statusLabel(item.status) }}
            </v-chip>
          </template>
          <template #[`item.actions`]="{ item }">
            <v-btn icon="mdi-pencil" variant="text" size="small" color="primary" :aria-label="t('common.edit')" @click="openEdit(item)" />
            <v-btn
              icon="mdi-delete"
              variant="text"
              size="small"
              color="error"
              :aria-label="t('accounts.delete.action')"
              @click="openDelete(item)"
            />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>

    <!-- Create -->
    <v-dialog v-model="createOpen" max-width="560" :fullscreen="isMobile">
      <v-card :class="{ 'acc-m__full': isMobile }">
        <v-card-title v-if="isMobile" class="d-flex align-center acc-m__dialog-title">
          <v-btn icon="mdi-close" variant="text" :aria-label="t('common.close')" @click="createOpen = false" />
          <span>{{ t("accounts.new") }}</span>
        </v-card-title>
        <v-card-title v-else>{{ t("accounts.new") }}</v-card-title>
        <v-form ref="createFormRef" @submit.prevent="submitCreate">
          <v-card-text>
            <v-text-field v-model="cName" :label="t('accounts.fields.name')" :rules="validations.required.any" />
            <v-text-field v-model="cSlug" :label="t('accounts.fields.slug')" :hint="t('accounts.fields.slugHint')" :rules="validations.slug" />
            <v-textarea v-model="cNote" :label="t('accounts.fields.note')" rows="2" />
            <v-switch v-model="withAdmin" :label="t('accounts.fields.withAdmin')" color="primary" />
            <template v-if="withAdmin">
              <v-text-field v-model="aEmail" :label="t('accounts.fields.adminEmail')" :rules="validations.required.email" />
              <v-text-field v-model="aName" :label="t('accounts.fields.adminName')" :rules="validations.required.any" />
              <v-text-field
                v-model="aPassword"
                :type="showAPassword ? 'text' : 'password'"
                :append-inner-icon="showAPassword ? 'mdi-eye-off' : 'mdi-eye'"
                :label="t('accounts.fields.adminPassword')"
                :rules="validations.required.passwordPolicy"
                @click:append-inner="showAPassword = !showAPassword"
              />
            </template>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn v-if="!isMobile" variant="text" @click="createOpen = false">{{ t("common.cancel") }}</v-btn>
            <v-btn color="primary" type="submit" :variant="isMobile ? 'flat' : undefined" :size="isMobile ? 'large' : undefined" :loading="creating">
              {{ t("accounts.create") }}
            </v-btn>
          </v-card-actions>
        </v-form>
      </v-card>
    </v-dialog>

    <!-- Edit -->
    <v-dialog v-model="editOpen" max-width="560" :fullscreen="isMobile" :scrollable="isMobile">
      <v-card>
        <v-card-title v-if="isMobile" class="d-flex align-center acc-m__dialog-title">
          <v-btn icon="mdi-close" variant="text" :aria-label="t('common.close')" @click="editOpen = false" />
          <span>{{ t("accounts.edit") }}</span>
        </v-card-title>
        <v-card-title v-else>{{ t("accounts.edit") }}</v-card-title>
        <v-card-text>
          <v-form ref="editFormRef" @submit.prevent="submitEdit">
          <v-text-field v-model="eName" :label="t('accounts.fields.name')" :rules="validations.required.any" />
          <v-textarea v-model="eNote" :label="t('accounts.fields.note')" rows="2" />
          <v-select v-model="eStatus" :items="statusItems" :label="t('accounts.fields.status')" :rules="validations.required.any" />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn v-if="!isMobile" variant="text" @click="editOpen = false">{{ t("common.cancel") }}</v-btn>
          <v-btn color="primary" :variant="isMobile ? 'flat' : undefined" :size="isMobile ? 'large' : undefined" :loading="saving" @click="submitEdit">{{ t("common.saveChanges") }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Secure multi-step delete -->
    <v-dialog v-model="deleteOpen" max-width="560" persistent>
      <v-card>
        <v-card-title class="text-error">{{ t("accounts.delete.title") }}</v-card-title>
        <v-card-text v-if="deleteStep === 1">
          <v-alert type="error" variant="tonal" class="mb-3">
            {{ t("accounts.delete.warning", { name: deleteTarget?.name }) }}
          </v-alert>
          <p class="text-body-2">{{ t("accounts.delete.warningDetail") }}</p>
        </v-card-text>
        <v-card-text v-else>
          <p class="text-body-2 mb-3">{{ t("accounts.delete.typeName", { name: deleteTarget?.name }) }}</p>
          <v-text-field
            v-model="confirmName"
            :label="t('accounts.delete.nameLabel')"
            :error="confirmName.length > 0 && !nameMatches"
            autocomplete="off"
          />
          <v-text-field
            v-model="confirmPassword"
            :type="showConfirmPassword ? 'text' : 'password'"
            :append-inner-icon="showConfirmPassword ? 'mdi-eye-off' : 'mdi-eye'"
            :label="t('accounts.delete.passwordLabel')"
            autocomplete="off"
            @click:append-inner="showConfirmPassword = !showConfirmPassword"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="deleteOpen = false">{{ t("common.cancel") }}</v-btn>
          <v-btn v-if="deleteStep === 1" color="error" @click="deleteStep = 2">
            {{ t("accounts.delete.proceed") }}
          </v-btn>
          <v-btn
            v-else
            color="error"
            :loading="deleting"
            :disabled="!nameMatches || !confirmPassword"
            @click="submitDelete"
          >
            {{ t("accounts.delete.confirm") }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
/* ── Phone: account cards ──────────────────────────────────────────────── */
.acc-m {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.acc-m__card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  background: rgb(var(--v-theme-surface));
  border: 1px solid var(--v-billy-border, #e2e4e9);
  border-radius: 16px;
  padding: 12px 8px 12px 14px;
}
.acc-m__avatar {
  flex: 0 0 auto;
}
.acc-m__titles {
  flex: 1 1 auto;
  min-width: 0;
}
.acc-m__name {
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}
.acc-m__slug {
  font-size: 0.875rem;
  color: var(--v-billy-text-2, rgba(var(--v-theme-on-surface), 0.7));
  overflow-wrap: anywhere;
}
.acc-m__menu {
  flex: 0 0 auto;
  margin-top: -4px;
}
.acc-m__dialog-title {
  padding-left: 8px !important;
  gap: 4px;
}
/* Fullscreen create: the form (title / scrolling fields / pinned actions). */
.acc-m__full {
  display: flex;
  flex-direction: column;
}
.acc-m__full > form {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.acc-m__full > form > .v-card-text {
  flex: 1 1 auto;
  overflow-y: auto;
}
.acc-m__full > form > .v-card-actions {
  border-top: 1px solid var(--v-billy-border, #e2e4e9);
}
</style>
