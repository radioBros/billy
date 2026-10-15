<script setup lang="ts">
/**
 * Credit notes list — server-paginated table through the mandated ServerTable.vue
 * Parent owns query state; fetches
 * GET /v1/credit-notes via the list grammar. Row click → detail.
 * Only whitelisted sort fields are marked sortable.
 */
import { ref, computed, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import { apiErrorReason } from "@/utils/validationMessages";
import type { ListQuery } from "@/api/client";
import type { ListMeta } from "@billy/types";
import type { CreditNote, EInvoiceStatus } from "@/types/domain";
import { useSettingsStore } from "@/stores/settings";
import { useAuthStore } from "@/stores/auth";
import { useClientNames } from "@/composables/useClientNames";
import { minorToDisplay } from "@/utils/money";
import ServerTable from "@/components/tables/ServerTable.vue";
import type { ServerTableCardLayout, ServerTableHeader } from "@/components/tables/ServerTable.vue";
import PageHeader from "@/components/PageHeader.vue";
import RowActionMenu from "@/components/tables/RowActionMenu.vue";
import type { RowAction } from "@/components/tables/RowActionMenu.vue";
import { useClonePrefill } from "@/composables/useClonePrefill";
import { confirm } from "@/composables/useConfirm";
import StatusChip from "@/components/StatusChip.vue";
import EInvoiceStatusChip from "@/components/einvoicing/EInvoiceStatusChip.vue";
import EInvoiceStatusFilter from "@/components/einvoicing/EInvoiceStatusFilter.vue";
import { isApiCode } from "@/composables/useEInvoice";
import { useToast } from "@/composables/useToast";
import { useEInvoicing } from "@/stores/einvoicing";
import PeriodBar from "@/components/PeriodBar.vue";
import { usePeriodStore } from "@/stores/period";
import { monthRangeBounds } from "@/utils/period";

const { t } = useI18n();
const router = useRouter();
const settings = useSettingsStore();
const auth = useAuthStore();
const { resolve: resolveClientNames, nameOf: clientNameOf } = useClientNames();
const period = usePeriodStore();
const einvoicing = useEInvoicing();
const { toast } = useToast();

const canDelete = computed<boolean>(
  () => auth.principal?.capabilities.canPermanentlyDelete === true,
);

/** Month bar selection (1-based month numbers; empty = whole year). */
const selectedMonths = ref<number[]>([]);

interface SortItem {
  key: string;
  order: "asc" | "desc";
}

const headers = computed<ServerTableHeader[]>(() => [
  { title: t("creditNotes.columns.number"), key: "creditNoteNumber", sortable: true },
  { title: t("documents.columns.customer"), key: "clientId", sortable: false },
  { title: t("creditNotes.columns.status"), key: "status", sortable: true },
  // SdI column only exists while e-invoicing is enabled. `forced` so users with saved
  // column prefs (written before this column existed) don't end up with it hidden.
  ...(einvoicing.enabled ? [{ title: t("einvoicing.list.column"), key: "einvoice", sortable: false, forced: true }] : []),
  { title: t("creditNotes.columns.issueDate"), key: "issueDate", sortable: true },
  { title: t("documents.columns.created"), key: "createdAt", sortable: true },
  { title: t("creditNotes.columns.total"), key: "grandTotalMinor", sortable: true, align: "end" },
  { title: "", key: "actions", sortable: false, align: "end", forced: true },
]);

/** Phone card: number + customer, status (+ SdI) chips + total, issue date. */
const cardLayout: ServerTableCardLayout = {
  title: "creditNoteNumber",
  subtitle: "clientId",
  status: ["status", "einvoice"],
  amount: "grandTotalMinor",
  meta: ["issueDate"],
};

const { cloneRow } = useClonePrefill();

const voidRow = async (item: CreditNote): Promise<void> => {
  const ok = await confirm({
    title: t("creditNotes.confirm.voidTitle"),
    message: t("creditNotes.confirm.voidMessage"),
    confirmText: t("creditNotes.void"),
    tone: "error",
  });
  if (!ok) return;
  try {
    await api.post<CreditNote>(`/v1/credit-notes/${item.id}/void`, undefined, { ifMatch: item.version });
    await fetchPage();
  } catch (err) {
    if (isApiCode(err, "EINVOICE_LEGALLY_ISSUED")) {
      toast.error(t("einvoicing.errors.legallyIssued"));
      await fetchPage();
      return;
    }
    errorMessage.value =
      err instanceof ApiError ? t("common.actionFailed", { code: apiErrorReason(err) }) : t("common.actionFailedGeneric");
  }
};

const rowActions = (item: CreditNote): RowAction[] => {
  const actions: RowAction[] = [
    {
      key: "open",
      title: t("rowActions.open"),
      icon: "mdi-open-in-app",
      handler: () => router.push({ name: "credit-note-detail", params: { id: item.id } }),
    },
    {
      key: "clone",
      title: t("rowActions.clone"),
      icon: "mdi-content-copy",
      handler: () => cloneRow("credit-note", item as unknown as Record<string, unknown>),
    },
  ];
  if (item.status !== "void" && item.einvoice?.legallyIssued !== true) {
    actions.push({
      key: "void",
      title: t("creditNotes.void"),
      icon: "mdi-cancel",
      tone: "error",
      handler: () => void voidRow(item),
    });
  }
  if (canDelete.value && item.status === "draft") {
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

// Delete is UI-limited to unnumbered drafts; issued credit notes use Void instead.
const deleteRow = async (item: CreditNote): Promise<void> => {
  const ok = await confirm({
    title: t("documents.confirm.deleteTitle"),
    message: t("documents.confirm.deleteMessage", { name: item.creditNoteNumber ?? t("documents.draft") }),
    confirmText: t("common.delete"),
    tone: "error",
  });
  if (!ok) return;
  try {
    await api.del(`/v1/credit-notes/${item.id}`);
    await fetchPage();
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError ? t("common.actionFailed", { code: apiErrorReason(err) }) : t("common.actionFailedGeneric");
  }
};

const items = ref<CreditNote[]>([]);
const total = ref(0);
const loading = ref(false);
const errorMessage = ref<string | null>(null);

const page = ref(1);
const itemsPerPage = ref(50);
const sortBy = ref<SortItem[]>([{ key: "issueDate", order: "desc" }]);
const search = ref("");
const einvoiceFilter = ref<EInvoiceStatus | null>(null);
/** Filters differing from their default — badges the phone filter button. */
const activeFilterCount = computed<number>(() => (einvoicing.enabled && einvoiceFilter.value != null ? 1 : 0));

const toSortParam = (items_: SortItem[]): string | undefined => {
  if (items_.length === 0) return undefined;
  return items_.map((s) => (s.order === "desc" ? `-${s.key}` : s.key)).join(",");
};

let requestSeq = 0;

const fetchPage = async (): Promise<void> => {
  const seq = ++requestSeq;
  loading.value = true;
  errorMessage.value = null;
  // Scope the list to the globally-selected year + month bar selection via the
  // issueDate range shortcut (`issueDate[gte]`/`issueDate[lte]`).
  const bounds = monthRangeBounds(period.year, selectedMonths.value);
  const query: ListQuery = {
    page: page.value,
    limit: itemsPerPage.value,
    sort: toSortParam(sortBy.value),
    q: search.value.trim() || undefined,
    einvoiceStatus: einvoicing.enabled ? (einvoiceFilter.value ?? undefined) : undefined,
    "issueDate[gte]": bounds.from,
    "issueDate[lte]": bounds.to,
  };
  try {
    const result = await api.list<CreditNote>("/v1/credit-notes", query);
    if (seq !== requestSeq) return;
    items.value = result.data;
    void resolveClientNames(result.data.map((r) => r.clientId));
    const meta: ListMeta = result.meta;
    total.value = typeof meta.total === "number" ? meta.total : result.data.length;
  } catch (err) {
    if (seq !== requestSeq) return;
    items.value = [];
    total.value = 0;
    errorMessage.value =
      err instanceof ApiError
        ? t("creditNotes.loadError", { code: apiErrorReason(err) })
        : t("creditNotes.loadErrorGeneric");
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
};

const openRow = (_e: unknown, ctx: { item: unknown }): void => {
  void router.push({ name: "credit-note-detail", params: { id: (ctx.item as CreditNote).id } });
};

watch([page, itemsPerPage, sortBy, search], () => {
  void fetchPage();
});

watch(einvoiceFilter, () => {
  if (page.value !== 1) page.value = 1;
  else void fetchPage();
});

// Global year change resets the month selection (months are year-scoped); a
// month-bar selection change (or the year reset) re-scopes the list to page 1.
watch(
  () => period.year,
  () => {
    selectedMonths.value = [];
  },
);
watch(
  selectedMonths,
  () => {
    if (page.value !== 1) page.value = 1;
    else void fetchPage();
  },
  { deep: true },
);

onMounted(() => {
  void einvoicing.load();
  void settings.load();
  void fetchPage();
});
</script>

<template>
  <div>
    <PageHeader
      :title="t('creditNotes.title')"
      :primary="{ label: t('creditNotes.new'), icon: 'mdi-plus', to: { name: 'credit-note-create' } }"
    />

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
        <v-btn color="primary" size="small" @click="fetchPage">{{ t("creditNotes.retry") }}</v-btn>
      </template>
    </v-alert>

    <!-- Month bar: per-month count + € total for the global year; selecting
         month(s) filters the table below (empty = whole year). -->
    <PeriodBar v-model:months="selectedMonths" kind="creditNotes" />

    <v-card variant="outlined" rounded="lg">
      <ServerTable
        v-model:page="page"
        v-model:ipp="itemsPerPage"
        v-model:sort-by="sortBy"
        v-model:search="search"
        table-name="credit-notes"
        :headers="headers"
        :items="items"
        :total="total"
        :loading="loading"
        :card-layout="cardLayout"
        :active-filters="activeFilterCount"
        @click:row="openRow"
      >
        <template #toolbar>
          <EInvoiceStatusFilter v-if="einvoicing.enabled" v-model="einvoiceFilter" />
        </template>
        <template #[`item.creditNoteNumber`]="{ item }">
          {{ (item as CreditNote).creditNoteNumber ?? t("creditNotes.draftUnnumbered") }}
        </template>
        <template #[`item.status`]="{ item }">
          <StatusChip :status="(item as CreditNote).status" />
        </template>
        <template #[`item.einvoice`]="{ item, card }">
          <EInvoiceStatusChip v-if="(item as CreditNote).einvoice" :status="(item as CreditNote).einvoice!.status" />
          <span v-else-if="!card">&mdash;</span>
        </template>
        <template #[`item.grandTotalMinor`]="{ item }">
          {{ minorToDisplay((item as CreditNote).grandTotalMinor, (item as CreditNote).currency) }}
        </template>
        <template #[`item.clientId`]="{ item }">
          {{ clientNameOf(item.clientId) ?? "\u2014" }}
        </template>
        <template #[`item.createdAt`]="{ item }">
          {{ String(item.createdAt ?? "").slice(0, 10) }}
        </template>
        <template #[`item.actions`]="{ item }">
          <RowActionMenu
            :actions="rowActions(item as CreditNote)"
            document-type="credit-note"
            :document-id="(item as CreditNote).id"
          />
        </template>
        <template #no-data>
          <div class="pa-8 text-center" style="color: var(--v-billy-text-3)">
            <v-icon icon="mdi-file-document-minus-outline" size="32" class="mb-2" />
            <div class="text-body-1">{{ t("creditNotes.empty") }}</div>
          </div>
        </template>
      </ServerTable>
    </v-card>
  </div>
</template>
