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
const createForm = ref<{ valid: boolean }>({ valid: false });
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
  createOpen.value = true;
};

const submitCreate = async (): Promise<void> => {
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

const openEdit = (acc: Account): void => {
  editing.value = acc;
  eName.value = acc.name;
  eNote.value = acc.note ?? "";
  eStatus.value = acc.status;
  editOpen.value = true;
};

const submitEdit = async (): Promise<void> => {
  if (!editing.value) return;
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
    <div class="d-flex align-center mb-4" style="gap: 12px">
      <h1 class="text-h5">{{ t("accounts.title") }}</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">
        {{ t("accounts.new") }}
      </v-btn>
    </div>

    <v-card variant="flat" border>
      <v-card-title class="text-subtitle-1 font-weight-medium">{{ t("accounts.listTitle") }}</v-card-title>
      <v-card-text>
        <v-data-table :headers="headers" :items="accounts" :loading="loading" density="comfortable">
          <template #[`item.status`]="{ item }">
            <v-chip :color="item.status === 'active' ? 'success' : 'warning'" size="small" variant="tonal">
              {{ item.status }}
            </v-chip>
          </template>
          <template #[`item.actions`]="{ item }">
            <v-btn icon="mdi-pencil" variant="text" size="small" :aria-label="t('common.edit')" @click="openEdit(item)" />
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
    <v-dialog v-model="createOpen" max-width="560">
      <v-card>
        <v-card-title>{{ t("accounts.new") }}</v-card-title>
        <v-form v-model="createForm.valid" @submit.prevent="submitCreate">
          <v-card-text>
            <v-text-field v-model="cName" :label="t('accounts.fields.name')" :rules="validations.required.any" />
            <v-text-field v-model="cSlug" :label="t('accounts.fields.slug')" :hint="t('accounts.fields.slugHint')" />
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
                :rules="validations.required.basicPassword"
                @click:append-inner="showAPassword = !showAPassword"
              />
            </template>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn variant="text" @click="createOpen = false">{{ t("common.cancel") }}</v-btn>
            <v-btn color="primary" type="submit" :loading="creating" :disabled="!createForm.valid">
              {{ t("accounts.create") }}
            </v-btn>
          </v-card-actions>
        </v-form>
      </v-card>
    </v-dialog>

    <!-- Edit -->
    <v-dialog v-model="editOpen" max-width="560">
      <v-card>
        <v-card-title>{{ t("accounts.edit") }}</v-card-title>
        <v-card-text>
          <v-text-field v-model="eName" :label="t('accounts.fields.name')" />
          <v-textarea v-model="eNote" :label="t('accounts.fields.note')" rows="2" />
          <v-select v-model="eStatus" :items="['active', 'suspended']" :label="t('accounts.fields.status')" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="editOpen = false">{{ t("common.cancel") }}</v-btn>
          <v-btn color="primary" :loading="saving" @click="submitEdit">{{ t("common.saveChanges") }}</v-btn>
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
