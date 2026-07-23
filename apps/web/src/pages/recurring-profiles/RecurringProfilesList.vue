<script setup lang="ts">
/**
 * Recurring profiles list — server-paginated table through the mandated
 * ServerTable.vue. Parent owns query state; fetches
 * GET /v1/recurring-profiles via the list grammar. Row click → detail.
 *
 * Recurring profiles carry no document "number" (the scheduler generates
 * invoices which get numbered); columns are client/interval/status/next run/
 * total. Only whitelisted sort fields are marked sortable.
 */
import { ref, computed, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import type { ListQuery } from "@/api/client";
import type { ListMeta } from "@billy/types";
import type { RecurringProfile } from "@/types/domain";
import { useSettingsStore } from "@/stores/settings";
import { minorToDisplay } from "@/utils/money";
import ServerTable from "@/components/tables/ServerTable.vue";
import type { ServerTableHeader } from "@/components/tables/ServerTable.vue";
import StatusChip from "@/components/StatusChip.vue";

const { t } = useI18n();
const router = useRouter();
const settings = useSettingsStore();

interface SortItem {
  key: string;
  order: "asc" | "desc";
}

const headers = computed<ServerTableHeader[]>(() => [
  { title: t("recurring.columns.client"), key: "clientId", sortable: false },
  { title: t("recurring.columns.docType"), key: "documentType", sortable: false },
  { title: t("recurring.columns.interval"), key: "interval", sortable: false },
  { title: t("recurring.columns.status"), key: "status", sortable: true },
  { title: t("recurring.columns.nextRun"), key: "nextRunAt", sortable: true },
  { title: t("recurring.columns.total"), key: "grandTotalMinor", sortable: true, align: "end" },
]);

const items = ref<RecurringProfile[]>([]);
const total = ref(0);
const loading = ref(false);
const errorMessage = ref<string | null>(null);

const page = ref(1);
const itemsPerPage = ref(50);
const sortBy = ref<SortItem[]>([{ key: "nextRunAt", order: "asc" }]);
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
    const result = await api.list<RecurringProfile>("/v1/recurring-profiles", query);
    if (seq !== requestSeq) return;
    items.value = result.data;
    const meta: ListMeta = result.meta;
    total.value = typeof meta.total === "number" ? meta.total : result.data.length;
  } catch (err) {
    if (seq !== requestSeq) return;
    items.value = [];
    total.value = 0;
    errorMessage.value =
      err instanceof ApiError
        ? t("recurring.loadError", { code: err.code })
        : t("recurring.loadErrorGeneric");
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
};

const docTypeLabel = (p: RecurringProfile): string => {
  return t(`enums.recurringDocType.${p.documentType ?? "invoice"}`);
};

const intervalLabel = (p: RecurringProfile): string => {
  const base = t(`recurring.interval.${p.interval}`);
  return p.intervalCount > 1 ? t("recurring.everyN", { n: p.intervalCount, unit: base }) : base;
};

const openRow = (_e: unknown, ctx: { item: unknown }): void => {
  void router.push({ name: "recurring-profile-detail", params: { id: (ctx.item as RecurringProfile).id } });
};

watch([page, itemsPerPage, sortBy, search], () => {
  void fetchPage();
});

onMounted(() => {
  void settings.load();
  void fetchPage();
});
</script>

<template>
  <div>
    <div class="mb-4">
      <h1 class="text-h5">{{ t("recurring.title") }}</h1>
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
        <v-btn variant="text" size="small" @click="fetchPage">{{ t("recurring.retry") }}</v-btn>
      </template>
    </v-alert>

    <v-card variant="outlined" rounded="lg">
      <ServerTable
        v-model:page="page"
        v-model:ipp="itemsPerPage"
        v-model:sort-by="sortBy"
        v-model:search="search"
        table-name="recurring-profiles"
        :headers="headers"
        :items="items"
        :total="total"
        :loading="loading"
        @click:row="openRow"
      >
        <template #[`item.documentType`]="{ item }">
          {{ docTypeLabel(item as RecurringProfile) }}
        </template>
        <template #[`item.interval`]="{ item }">
          {{ intervalLabel(item as RecurringProfile) }}
        </template>
        <template #[`item.status`]="{ item }">
          <StatusChip :status="(item as RecurringProfile).status" />
        </template>
        <template #[`item.grandTotalMinor`]="{ item }">
          {{ minorToDisplay((item as RecurringProfile).grandTotalMinor, (item as RecurringProfile).currency) }}
        </template>
        <template #no-data>
          <div class="pa-8 text-center" style="color: var(--v-billy-text-3)">
            <v-icon icon="mdi-autorenew-off" size="32" class="mb-2" />
            <div class="text-body-1">{{ t("recurring.empty") }}</div>
          </div>
        </template>
      </ServerTable>
    </v-card>
  </div>
</template>
