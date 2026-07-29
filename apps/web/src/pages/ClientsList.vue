<script setup lang="ts">
/**
 * Clients list — server-paginated table rendered through the mandated
 * ServerTable.vue (all record lists render through
 * ServerTable). The parent owns query state (page/ipp/sort/search) and fetches
 * GET /api/v1/clients via the list grammar; no full-collection client-side
 * loading. Loading / empty / error states are all rendered.
 *
 * Column visibility/order persist per-user via the settings store keyed by
 * tableName="clients" (ServerTable → ColManager → /me/settings).
 *
 * Row actions: edit + archive on live rows, restore on archived ones, and
 * delete (admins with canPermanentlyDelete only — the backend also rejects a
 * client that has any document with CLIENT_HAS_DOCUMENTS). The "show archived"
 * switch widens the list query to archived=all.
 */
import { ref, computed, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { localizedCountryName } from "@/constants/countries";
import { api, ApiError } from "@/api/client";
import { apiErrorReason } from "@/utils/validationMessages";
import type { ListQuery } from "@/api/client";
import type { ListMeta } from "@billy/types";
import type { Client } from "@/types/domain";
import { useSettingsStore } from "@/stores/settings";
import { useAuthStore } from "@/stores/auth";
import { confirm } from "@/composables/useConfirm";
import { useToast } from "@/composables/useToast";
import ServerTable from "@/components/tables/ServerTable.vue";
import type { ServerTableHeader } from "@/components/tables/ServerTable.vue";
import RowActionMenu from "@/components/tables/RowActionMenu.vue";
import type { RowAction } from "@/components/tables/RowActionMenu.vue";

const { t, locale } = useI18n();
const router = useRouter();
const settings = useSettingsStore();
const auth = useAuthStore();
const { toast } = useToast();

const canDelete = computed<boolean>(
  () => auth.principal?.capabilities.canPermanentlyDelete === true,
);

interface SortItem {
  key: string;
  order: "asc" | "desc";
}

// Header keys are the resource's whitelisted sort fields; non-sortable columns
// set sortable:false.
const headers = computed<ServerTableHeader[]>(() => [
  { title: t("clients.columns.name"), key: "displayName", sortable: true },
  { title: t("clients.columns.type"), key: "type", sortable: true },
  { title: t("clients.columns.email"), key: "email", sortable: false },
  { title: t("clients.columns.vatNumber"), key: "vatNumber", sortable: false },
  { title: t("clients.columns.country"), key: "billingAddress.country", sortable: false },
  { title: t("clients.columns.currency"), key: "preferredCurrency", sortable: false },
  { title: "", key: "actions", sortable: false, align: "end" },
]);

const goToNew = (): void => {
  void router.push({ name: "client-new" });
};

const goToEdit = (clientId: string): void => {
  void router.push({ name: "client-edit", params: { id: clientId } });
};

const openRow = (_e: unknown, ctx: { item: unknown }): void => {
  const row = ctx.item as Client;
  // Archived rows are not served by GET /:id (platform-wide) — restore first.
  if (row.archivedAt) return;
  goToEdit(row.id);
};

const items = ref<Client[]>([]);
const total = ref(0);
const loading = ref(false);
const errorMessage = ref<string | null>(null);

const page = ref(1);
const itemsPerPage = ref(50);
const sortBy = ref<SortItem[]>([{ key: "displayName", order: "asc" }]);
const search = ref("");
const showArchived = ref(false);

// ── Row lifecycle actions ─────────────────────────────────────────────────────

const archiveRow = async (item: Client): Promise<void> => {
  const ok = await confirm({
    title: t("clients.confirm.archiveTitle"),
    message: t("clients.confirm.archiveMessage", { name: item.displayName }),
    confirmText: t("clients.archive"),
    tone: "warning",
  });
  if (!ok) return;
  try {
    await api.post(`/v1/clients/${item.id}/archive`, undefined, { ifMatch: item.version });
    toast.success(t("clients.archived"));
    await fetchPage();
  } catch (err) {
    toast.error(
      err instanceof ApiError
        ? t("common.actionFailed", { code: apiErrorReason(err) })
        : t("common.actionFailedGeneric"),
    );
  }
};

const restoreRow = async (item: Client): Promise<void> => {
  try {
    await api.post(`/v1/clients/${item.id}/restore`, undefined, { ifMatch: item.version });
    toast.success(t("clients.restored"));
    await fetchPage();
  } catch (err) {
    toast.error(
      err instanceof ApiError
        ? t("common.actionFailed", { code: apiErrorReason(err) })
        : t("common.actionFailedGeneric"),
    );
  }
};

const deleteRow = async (item: Client): Promise<void> => {
  const ok = await confirm({
    title: t("clients.confirm.deleteTitle"),
    message: t("clients.confirm.deleteMessage", { name: item.displayName }),
    confirmText: t("common.delete"),
    tone: "error",
  });
  if (!ok) return;
  try {
    await api.del(`/v1/clients/${item.id}`);
    toast.success(t("clients.deleted"));
    await fetchPage();
  } catch (err) {
    if (err instanceof ApiError && err.code === "CLIENT_HAS_DOCUMENTS") {
      toast.error(t("clients.deleteBlocked", { name: item.displayName }));
    } else {
      toast.error(
        err instanceof ApiError
          ? t("common.actionFailed", { code: apiErrorReason(err) })
          : t("common.actionFailedGeneric"),
      );
    }
  }
};

const rowActions = (item: Client): RowAction[] => {
  const actions: RowAction[] = [];
  if (!item.archivedAt) {
    actions.push({ key: "edit", title: t("common.edit"), icon: "mdi-pencil", handler: () => goToEdit(item.id) });
    actions.push({
      key: "archive",
      title: t("clients.archive"),
      icon: "mdi-archive-arrow-down-outline",
      handler: () => void archiveRow(item),
    });
  } else {
    actions.push({
      key: "restore",
      title: t("clients.restore"),
      icon: "mdi-archive-arrow-up-outline",
      handler: () => void restoreRow(item),
    });
  }
  if (canDelete.value) {
    actions.push({
      key: "delete",
      title: t("common.delete"),
      icon: "mdi-delete-outline",
      tone: "error",
      handler: () => void deleteRow(item),
    });
  }
  return actions;
};

const toSortParam = (items_: SortItem[]): string | undefined => {
  if (items_.length === 0) return undefined;
  return items_.map((s) => (s.order === "desc" ? `-${s.key}` : s.key)).join(",");
};

let requestSeq = 0;

const fetchPage = async (): Promise<void> => {
  const seq = ++requestSeq;
  loading.value = true;
  errorMessage.value = null;
  const query: ListQuery = {
    page: page.value,
    limit: itemsPerPage.value,
    sort: toSortParam(sortBy.value),
    q: search.value.trim() || undefined,
    archived: showArchived.value ? "all" : undefined,
  };
  try {
    const result = await api.list<Client>("/v1/clients", query);
    if (seq !== requestSeq) return; // a newer request superseded this one
    items.value = result.data;
    const meta: ListMeta = result.meta;
    total.value = typeof meta.total === "number" ? meta.total : result.data.length;
  } catch (err) {
    if (seq !== requestSeq) return;
    items.value = [];
    total.value = 0;
    errorMessage.value =
      err instanceof ApiError
        ? t("clients.loadError", { code: apiErrorReason(err) })
        : t("clients.loadErrorGeneric");
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
};

// ServerTable owns each state slice via v-model (page/ipp/sort-by/search) and
// debounces the search internally (320ms). A single watcher drives the refetch:
// any change to page/ipp/sort/search re-queries the endpoint. When search
// changes ServerTable also resets page to 1 in the same tick, so the two writes
// batch into one fetch.
watch([page, itemsPerPage, sortBy, search, showArchived], () => {
  void fetchPage();
});

onMounted(() => {
  // Load saved column prefs so ColManager restores visibility/order.
  void settings.load();
  void fetchPage();
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 16px">
      <h1 class="text-h5">{{ t("clients.title") }}</h1>
      <v-spacer />
      <v-switch
        v-model="showArchived"
        :label="t('clients.showArchived')"
        color="primary"
        density="compact"
        hide-details
        class="flex-grow-0"
      />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="goToNew">
        {{ t("clients.new") }}
      </v-btn>
    </div>

    <v-alert
      v-if="errorMessage"
      type="error"
      variant="tonal"
      density="compact"
      class="mb-4"
      role="alert"
    >
      {{ errorMessage }}
      <template #append>
        <v-btn color="primary" size="small" @click="fetchPage">{{ t("clients.retry") }}</v-btn>
      </template>
    </v-alert>

    <v-card variant="outlined" rounded="lg">
      <ServerTable
        v-model:page="page"
        v-model:ipp="itemsPerPage"
        v-model:sort-by="sortBy"
        v-model:search="search"
        table-name="clients"
        :headers="headers"
        :items="items"
        :total="total"
        :loading="loading"
        @click:row="openRow"
      >
        <template #[`item.displayName`]="{ item }">
          <span class="d-inline-flex align-center" style="gap: 8px">
            {{ (item as Client).displayName }}
            <v-chip v-if="(item as Client).archivedAt" size="x-small" variant="tonal">
              {{ t("clients.archivedChip") }}
            </v-chip>
          </span>
        </template>
        <template #[`item.billingAddress.country`]="{ item }">
          {{ localizedCountryName(item.billingAddress?.country, locale) }}
        </template>
        <template #[`item.actions`]="{ item }">
          <RowActionMenu :actions="rowActions(item as Client)" />
        </template>
        <template #no-data>
          <div class="pa-8 text-center" style="color: var(--v-billy-text-3)">
            <v-icon icon="mdi-account-off-outline" size="32" class="mb-2" />
            <div class="text-body-1">{{ t("clients.empty") }}</div>
          </div>
        </template>
      </ServerTable>
    </v-card>
  </div>
</template>
