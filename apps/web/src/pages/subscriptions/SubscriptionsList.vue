<script setup lang="ts">
/**
 * Subscriptions list — server-paginated table rendered through the mandated
 * ServerTable.vue hitting GET /v1/subscriptions via the
 * list grammar. Parent owns query state; ServerTable owns the search field + its
 * debounce. Row click → subscription edit page.
 */
import { ref, computed, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import type { ListQuery } from "@/api/client";
import type { ListMeta } from "@billy/types";
import type { Subscription, SubscriptionStatus } from "@/types/domain";
import { minorToDisplay } from "@/utils/money";
import { enumLabel } from "@/utils/enums";
import { useSettingsStore } from "@/stores/settings";
import StatusChip from "@/components/StatusChip.vue";
import ServerTable from "@/components/tables/ServerTable.vue";
import type { ServerTableHeader } from "@/components/tables/ServerTable.vue";

interface SortItem {
  key: string;
  order: "asc" | "desc";
}

const { t } = useI18n();
const router = useRouter();
const settings = useSettingsStore();

const headers = computed<ServerTableHeader[]>(() => [
  { title: t("subscriptions.columns.name"), key: "name", sortable: true },
  { title: t("subscriptions.columns.plan"), key: "plan", sortable: false },
  { title: t("subscriptions.columns.amount"), key: "amountMinor", sortable: true, align: "end" },
  { title: t("subscriptions.columns.interval"), key: "interval", sortable: false },
  { title: t("subscriptions.columns.status"), key: "status", sortable: true },
  { title: t("subscriptions.columns.nextBilling"), key: "nextBillingDate", sortable: true },
]);

// Status filter has ≤4 options → stays a plain v-select.
const STATUS_OPTIONS: SubscriptionStatus[] = ["active", "paused", "cancelled"];
// Translated option labels; the raw code stays as the submitted value.
const STATUS_ITEMS = computed(() =>
  STATUS_OPTIONS.map((v) => ({ title: enumLabel(t, "status", v), value: v })),
);

const items = ref<Subscription[]>([]);
const total = ref(0);
const loading = ref(false);
const errorMessage = ref<string | null>(null);

const page = ref(1);
const itemsPerPage = ref(50);
const sortBy = ref<SortItem[]>([{ key: "nextBillingDate", order: "asc" }]);
const search = ref("");
const statusFilter = ref<SubscriptionStatus | null>(null);

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
    status: statusFilter.value ?? undefined,
  };
  try {
    const result = await api.list<Subscription>("/v1/subscriptions", query);
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
        ? t("subscriptions.loadError", { code: err.code })
        : t("subscriptions.loadErrorGeneric");
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
};

watch([page, itemsPerPage, sortBy, search], () => {
  void fetchPage();
});

watch(statusFilter, () => {
  if (page.value !== 1) page.value = 1;
  else void fetchPage();
});

const openRow = (_e: unknown, ctx: { item: unknown }): void => {
  const row = ctx.item as Subscription;
  void router.push({ name: "subscription-edit", params: { id: row.id } });
};

onMounted(() => {
  void settings.load();
  void fetchPage();
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 16px">
      <h1 class="text-h5">{{ t("subscriptions.title") }}</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" :to="{ name: 'subscription-create' }">
        {{ t("subscriptions.new") }}
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
        <v-btn variant="text" size="small" @click="fetchPage">{{ t("common.retry") }}</v-btn>
      </template>
    </v-alert>

    <v-card variant="outlined" rounded="lg">
      <ServerTable
        v-model:page="page"
        v-model:ipp="itemsPerPage"
        v-model:sort-by="sortBy"
        v-model:search="search"
        table-name="subscriptions"
        :headers="headers"
        :items="items"
        :total="total"
        :loading="loading"
        @click:row="openRow"
      >
        <template #toolbar>
          <v-select
            v-model="statusFilter"
            :items="STATUS_ITEMS"
            :label="t('subscriptions.columns.status')"
            density="compact"
            hide-details
            clearable
            max-width="200"
            :aria-label="t('subscriptions.filterStatus')"
          />
        </template>
        <template #[`item.amountMinor`]="{ item }">
          {{ minorToDisplay(item.amountMinor, item.currency) }}
        </template>
        <template #[`item.interval`]="{ item }">
          {{ t(`recurring.interval.${item.interval}`) }}
        </template>
        <template #[`item.status`]="{ item }">
          <StatusChip :status="item.status" />
        </template>
        <template #no-data>
          <div class="pa-8 text-center" style="color: var(--v-billy-text-3)">
            <v-icon icon="mdi-credit-card-off-outline" size="32" class="mb-2" />
            <div class="text-body-1">{{ t("subscriptions.empty") }}</div>
          </div>
        </template>
      </ServerTable>
    </v-card>
  </div>
</template>
