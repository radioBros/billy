<script setup lang="ts">
/**
 * Projects list — server-paginated table rendered through the mandated
 * ServerTable.vue. The parent owns query state (page/ipp/sort/search) and
 * fetches GET /api/v1/projects via the list grammar. Row click → edit.
 * Row actions: edit and delete (with a confirm). Column visibility/order
 * persist per-user via the settings store keyed by tableName="projects".
 */
import { ref, computed, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import type { ListQuery } from "@/api/client";
import type { ListMeta } from "@billy/types";
import type { Project } from "@/types/domain";
import { useSettingsStore } from "@/stores/settings";
import { confirm } from "@/composables/useConfirm";
import ServerTable from "@/components/tables/ServerTable.vue";
import type { ServerTableHeader } from "@/components/tables/ServerTable.vue";
import RowActionMenu from "@/components/tables/RowActionMenu.vue";
import type { RowAction } from "@/components/tables/RowActionMenu.vue";
import StatusChip from "@/components/StatusChip.vue";

const { t } = useI18n();
const router = useRouter();
const settings = useSettingsStore();

interface SortItem {
  key: string;
  order: "asc" | "desc";
}

// Header keys are the resource's whitelisted sort fields; non-sortable columns
// set sortable:false.
const headers = computed<ServerTableHeader[]>(() => [
  { title: t("projects.columns.name"), key: "name", sortable: true },
  { title: t("projects.columns.description"), key: "description", sortable: false },
  { title: t("projects.columns.status"), key: "status", sortable: true },
  { title: t("projects.columns.color"), key: "color", sortable: false },
  { title: "", key: "actions", sortable: false, align: "end", forced: true },
]);

const goToNew = (): void => {
  void router.push({ name: "project-create" });
};

const goToEdit = (projectId: string): void => {
  void router.push({ name: "project-edit", params: { id: projectId } });
};

const openRow = (_e: unknown, ctx: { item: unknown }): void => {
  goToEdit((ctx.item as Project).id);
};

const deleteRow = async (item: Project): Promise<void> => {
  const ok = await confirm({
    title: t("projects.confirm.deleteTitle"),
    message: t("projects.confirm.deleteMessage", { name: item.name }),
    confirmText: t("projects.delete"),
    tone: "error",
  });
  if (!ok) return;
  try {
    await api.del(`/v1/projects/${item.id}`, { ifMatch: item.version });
    await fetchPage();
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError
        ? t("common.actionFailed", { code: err.code })
        : t("common.actionFailedGeneric");
  }
};

const rowActions = (item: Project): RowAction[] => [
  {
    key: "edit",
    title: t("common.edit"),
    icon: "mdi-pencil",
    handler: () => goToEdit(item.id),
  },
  {
    key: "delete",
    title: t("common.delete"),
    icon: "mdi-delete-outline",
    tone: "error",
    handler: () => void deleteRow(item),
  },
];

const items = ref<Project[]>([]);
const total = ref(0);
const loading = ref(false);
const errorMessage = ref<string | null>(null);

const page = ref(1);
const itemsPerPage = ref(50);
const sortBy = ref<SortItem[]>([{ key: "name", order: "asc" }]);
const search = ref("");

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
  };
  try {
    const result = await api.list<Project>("/v1/projects", query);
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
        ? t("projects.loadError", { code: err.code })
        : t("projects.loadErrorGeneric");
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
};

watch([page, itemsPerPage, sortBy, search], () => {
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
      <h1 class="text-h5">{{ t("projects.title") }}</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="goToNew">
        {{ t("projects.new") }}
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
        <v-btn variant="text" size="small" @click="fetchPage">{{ t("projects.retry") }}</v-btn>
      </template>
    </v-alert>

    <v-card variant="outlined" rounded="lg">
      <ServerTable
        v-model:page="page"
        v-model:ipp="itemsPerPage"
        v-model:sort-by="sortBy"
        v-model:search="search"
        table-name="projects"
        :headers="headers"
        :items="items"
        :total="total"
        :loading="loading"
        @click:row="openRow"
      >
        <template #[`item.description`]="{ item }">
          <span class="d-inline-block text-truncate" style="max-width: 320px">
            {{ (item as Project).description || "—" }}
          </span>
        </template>
        <template #[`item.status`]="{ item }">
          <StatusChip :status="(item as Project).status" />
        </template>
        <template #[`item.color`]="{ item }">
          <span
            v-if="(item as Project).color"
            class="d-inline-flex align-center"
            style="gap: 8px"
          >
            <span
              class="projects-swatch"
              :style="{ backgroundColor: (item as Project).color as string }"
            />
            <span class="text-caption">{{ (item as Project).color }}</span>
          </span>
          <span v-else>—</span>
        </template>
        <template #[`item.actions`]="{ item }">
          <RowActionMenu :actions="rowActions(item as Project)" />
        </template>
        <template #no-data>
          <div class="pa-8 text-center" style="color: var(--v-billy-text-3)">
            <v-icon icon="mdi-folder-off-outline" size="32" class="mb-2" />
            <div class="text-body-1">{{ t("projects.empty") }}</div>
          </div>
        </template>
      </ServerTable>
    </v-card>
  </div>
</template>

<style scoped>
.projects-swatch {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity, 0.24));
  flex: 0 0 auto;
}
</style>
