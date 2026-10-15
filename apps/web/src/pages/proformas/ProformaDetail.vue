<script setup lang="ts">
/**
 * Proforma detail — shows the (non-fiscal) document + line items and the guarded
 * lifecycle actions (proforma routes): issue (draft → issued, assigns PRO-
 * number) and void (→ terminal). Both send the optimistic-concurrency `version`
 * via If-Match (the routes require it), mirroring InvoiceDetail's finalize/void.
 */
import { ref, computed, watch, onMounted } from "vue";
import { useClientNames } from "@/composables/useClientNames";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import { apiErrorReason } from "@/utils/validationMessages";
import type { Proforma, Invoice } from "@/types/domain";
import { minorToDisplay } from "@/utils/money";
import StatusChip from "@/components/StatusChip.vue";
import AppCard from "@/components/AppCard.vue";
import PageHeader from "@/components/PageHeader.vue";
import { useIsMobile } from "@/composables/useIsMobile";
import DocumentActions from "@/components/DocumentActions.vue";
import InvoiceLink from "@/components/InvoiceLink.vue";
import { confirm } from "@/composables/useConfirm";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const isMobile = useIsMobile();
const id = computed<string>(() => route.params.id as string);

const proforma = ref<Proforma | null>(null);
const { resolve: resolveClientNames, nameOf: clientNameOf } = useClientNames();
// Resolve the client display name once the document is loaded.
watch(proforma, (v) => {
  if (v?.clientId) void resolveClientNames([v.clientId]);
});
const loading = ref(false);
const errorMessage = ref<string | null>(null);
const actionError = ref<string | null>(null);
const acting = ref(false);

const isDraft = computed<boolean>(() => proforma.value?.status === "draft");
const canVoid = computed<boolean>(() => proforma.value != null && proforma.value.status !== "void");

const load = async (): Promise<void> => {
  loading.value = true;
  errorMessage.value = null;
  try {
    proforma.value = await api.get<Proforma>(`/v1/proformas/${id.value}`);
  } catch (err) {
    proforma.value = null;
    errorMessage.value =
      err instanceof ApiError ? t("proformas.loadError", { code: apiErrorReason(err) }) : t("proformas.loadErrorGeneric");
  } finally {
    loading.value = false;
  }
};

const runAction = async (fn: () => Promise<Proforma>): Promise<void> => {
  actionError.value = null;
  acting.value = true;
  try {
    proforma.value = await fn();
  } catch (err) {
    actionError.value = err instanceof ApiError ? t("common.actionFailed", { code: apiErrorReason(err) }) : t("common.actionFailedGeneric");
  } finally {
    acting.value = false;
  }
};

const isIssued = computed<boolean>(() => proforma.value?.status === "issued");
const converting = ref(false);

const issue = async (): Promise<void> => {
  if (!proforma.value) return;
  const ok = await confirm({
    title: t("proformas.confirm.issueTitle"),
    message: t("proformas.confirm.issueMessage"),
    confirmText: t("proformas.issue"),
  });
  if (!ok) return;
  await runAction(() =>
    api.post<Proforma>(`/v1/proformas/${id.value}/issue`, undefined, { ifMatch: proforma.value!.version }),
  );
};
const voidProforma = async (): Promise<void> => {
  if (!proforma.value) return;
  const ok = await confirm({
    title: t("proformas.confirm.voidTitle"),
    message: t("proformas.confirm.voidMessage"),
    confirmText: t("proformas.void"),
    tone: "error",
  });
  if (!ok) return;
  await runAction(() =>
    api.post<Proforma>(`/v1/proformas/${id.value}/void`, undefined, { ifMatch: proforma.value!.version }),
  );
};

const convert = async (): Promise<void> => {
  if (!proforma.value) return;
  const ok = await confirm({
    title: t("proformas.confirm.convertTitle"),
    message: t("proformas.confirm.convertMessage"),
    confirmText: t("proformas.convert"),
  });
  if (!ok) return;
  actionError.value = null;
  converting.value = true;
  try {
    const invoice = await api.post<Invoice>(`/v1/proformas/${id.value}/convert`, undefined, {
      ifMatch: proforma.value.version,
    });
    await router.push({ name: "invoice-detail", params: { id: invoice.id } });
  } catch (err) {
    actionError.value =
      err instanceof ApiError ? t("common.actionFailed", { code: apiErrorReason(err) }) : t("common.actionFailedGeneric");
  } finally {
    converting.value = false;
  }
};

onMounted(() => {
  void load();
});
</script>

<template>
  <div>
    <PageHeader :title="t('proformas.detailTitle')" back>
      <!-- Phone: the destructive Void lives in an overflow menu. -->
      <template v-if="proforma && !loading && canVoid" #mobile-actions>
        <v-menu location="bottom end">
          <template #activator="{ props: menuProps }">
            <v-btn v-bind="menuProps" icon="mdi-dots-vertical" variant="text" :aria-label="t('rowActions.menu')" data-test="proforma-more" />
          </template>
          <v-list density="comfortable" min-width="220">
            <v-list-item prepend-icon="mdi-cancel" base-color="error" :title="t('proformas.void')" @click="voidProforma" />
          </v-list>
        </v-menu>
      </template>
    </PageHeader>

    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
      <template #append>
        <v-btn color="primary" size="small" @click="load">{{ t("proformas.retry") }}</v-btn>
      </template>
    </v-alert>

    <v-card v-if="loading" variant="outlined" rounded="lg" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </v-card>

    <template v-else-if="proforma">
      <v-alert v-if="actionError" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
        {{ actionError }}
      </v-alert>

      <!-- ── Phone: hero summary + actions ─────────────────────────────── -->
      <template v-if="isMobile">
        <section class="dd-card dd-hero">
          <div class="dd-hero__head">
            <div class="dd-hero__number">{{ proforma.proformaNumber ?? t("proformas.draftUnnumbered") }}</div>
            <div class="dd-hero__chips">
              <StatusChip :status="proforma.status" />
            </div>
          </div>
          <div class="dd-hero__client">{{ clientNameOf(proforma.clientId) ?? "\u2014" }}</div>

          <!-- Converted: link to the resulting invoice (never show its raw id). -->
          <v-alert
            v-if="proforma.convertedInvoiceId"
            type="success"
            variant="tonal"
            density="compact"
            class="mt-3"
          >
            {{ t("proformas.convertedShort") }}
            <template #append>
              <v-btn
                size="small"
                variant="text"
                color="success"
                :to="{ name: 'invoice-detail', params: { id: proforma.convertedInvoiceId } }"
              >
                {{ t("proformas.openInvoice") }}
              </v-btn>
            </template>
          </v-alert>

          <div class="dd-label mt-4">{{ t("proformas.totals.total") }}</div>
          <div class="dd-hero__total">{{ minorToDisplay(proforma.grandTotalMinor, proforma.currency) }}</div>

          <div class="dd-hero__meta">
            <div>
              <div class="dd-label">{{ t("proformas.fields.issueDate") }}</div>
              <div class="dd-value">{{ proforma.issueDate }}</div>
            </div>
            <div>
              <div class="dd-label">{{ t("proformas.fields.expiryDate") }}</div>
              <div class="dd-value">{{ proforma.expiryDate ?? "—" }}</div>
            </div>
          </div>
        </section>

        <div class="dd-actions">
          <div class="dd-actions__primary">
            <v-btn v-if="isDraft" color="primary" variant="flat" size="large" :loading="acting" @click="issue">
              {{ t("proformas.issue") }}
            </v-btn>
            <v-btn
              v-if="isDraft"
              color="primary"
              variant="tonal"
              size="large"
              prepend-icon="mdi-pencil"
              :to="{ name: 'proforma-edit', params: { id: proforma.id } }"
            >
              {{ t("common.edit") }}
            </v-btn>
            <v-btn
              v-if="isIssued && !proforma.convertedInvoiceId"
              color="primary"
              variant="flat"
              size="large"
              prepend-icon="mdi-file-move-outline"
              :loading="converting"
              @click="convert"
            >
              {{ t("proformas.convert") }}
            </v-btn>
          </div>
          <DocumentActions document-type="proforma" :document-id="proforma.id" />
        </div>
      </template>

      <AppCard v-else>
        <template #header>
          <div class="text-h6 mr-3">{{ proforma.proformaNumber ?? t("proformas.draftUnnumbered") }}</div>
          <StatusChip :status="proforma.status" />
        </template>

        <v-alert
          v-if="proforma.convertedInvoiceId"
          type="success"
          variant="tonal"
          density="compact"
          class="mb-4"
        >
          <!-- The {id} slot is the invoice NUMBER as a link, never the raw id. -->
          <i18n-t keypath="proformas.converted" tag="span">
            <template #id><InvoiceLink :invoice-id="proforma.convertedInvoiceId" /></template>
          </i18n-t>
        </v-alert>

        <v-row>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("proformas.fields.client") }}</div>{{ clientNameOf(proforma.clientId) ?? "\u2014" }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("proformas.fields.currency") }}</div>{{ proforma.currency }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("proformas.fields.issueDate") }}</div>{{ proforma.issueDate }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("proformas.fields.expiryDate") }}</div>{{ proforma.expiryDate ?? "—" }}</v-col>
        </v-row>

        <template #actions>
          <div class="d-flex align-center" style="gap: 8px; flex-wrap: wrap; width: 100%">
            <DocumentActions document-type="proforma" :document-id="proforma.id" />
            <v-spacer />
            <v-btn
              v-if="isDraft"
              color="primary"
              prepend-icon="mdi-pencil"
              :to="{ name: 'proforma-edit', params: { id: proforma.id } }"
            >
              {{ t("common.edit") }}
            </v-btn>
            <v-btn v-if="isDraft" color="primary" :loading="acting" @click="issue">{{ t("proformas.issue") }}</v-btn>
            <v-btn
              v-if="isIssued && !proforma.convertedInvoiceId"
              color="primary"
              prepend-icon="mdi-file-move-outline"
              :loading="converting"
              @click="convert"
            >
              {{ t("proformas.convert") }}
            </v-btn>
            <v-btn v-if="canVoid" color="error" :loading="acting" @click="voidProforma">
              {{ t("proformas.void") }}
            </v-btn>
          </div>
        </template>
      </AppCard>

      <!-- ── Phone: line cards + totals ──────────────────────────────── -->
      <section v-if="isMobile" class="dd-card">
        <div class="dd-section-title">{{ t("proformas.lineItems") }}</div>
        <div v-for="(li, i) in proforma.lineItems" :key="i" class="dd-line">
          <div class="dd-line__desc">{{ li.description }}</div>
          <div class="dd-line__row">
            <span class="dd-line__calc">
              {{ li.quantity }} × {{ minorToDisplay(li.unitPriceMinor, proforma.currency) }}
              <template v-if="li.discountRate"> · −{{ li.discountRate }}%</template>
              <template v-if="li.taxRate != null"> · {{ t("proformas.totals.tax") }} {{ li.taxRate }}%</template>
            </span>
            <span class="dd-line__total">{{ minorToDisplay(li.lineTotalMinor, proforma.currency) }}</span>
          </div>
        </div>
        <div class="dd-totals">
          <div class="dd-totals__row">
            <span>{{ t("proformas.totals.subtotal") }}</span><span>{{ minorToDisplay(proforma.subtotalMinor, proforma.currency) }}</span>
          </div>
          <div class="dd-totals__row">
            <span>{{ t("proformas.totals.tax") }}</span><span>{{ minorToDisplay(proforma.taxMinor, proforma.currency) }}</span>
          </div>
          <div class="dd-totals__row dd-totals__row--grand">
            <span>{{ t("proformas.totals.total") }}</span><span>{{ minorToDisplay(proforma.grandTotalMinor, proforma.currency) }}</span>
          </div>
        </div>
      </section>

      <v-card v-else variant="outlined" rounded="lg">
        <v-card-text>
        <div class="text-subtitle-2 mb-2">{{ t("proformas.lineItems") }}</div>
        <v-table density="compact">
          <thead>
            <tr>
              <th>{{ t("proformas.lineCols.description") }}</th>
              <th class="text-right">{{ t("proformas.lineCols.qty") }}</th>
              <th class="text-right">{{ t("proformas.lineCols.unit") }}</th>
              <th class="text-right">{{ t("proformas.lineCols.total") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(li, i) in proforma.lineItems" :key="i">
              <td>{{ li.description }}</td>
              <td class="text-right">{{ li.quantity }}</td>
              <td class="text-right">{{ minorToDisplay(li.unitPriceMinor, proforma.currency) }}</td>
              <td class="text-right">{{ minorToDisplay(li.lineTotalMinor, proforma.currency) }}</td>
            </tr>
          </tbody>
        </v-table>
        <v-divider class="my-3" />
        <div class="d-flex justify-end">
          <div style="min-width: 240px">
            <div class="d-flex justify-space-between">
              <span>{{ t("proformas.totals.subtotal") }}</span><span>{{ minorToDisplay(proforma.subtotalMinor, proforma.currency) }}</span>
            </div>
            <div class="d-flex justify-space-between">
              <span>{{ t("proformas.totals.tax") }}</span><span>{{ minorToDisplay(proforma.taxMinor, proforma.currency) }}</span>
            </div>
            <div class="d-flex justify-space-between text-subtitle-1 font-weight-medium">
              <span>{{ t("proformas.totals.total") }}</span><span>{{ minorToDisplay(proforma.grandTotalMinor, proforma.currency) }}</span>
            </div>
          </div>
        </div>
        </v-card-text>
      </v-card>
    </template>
  </div>
</template>

<style scoped>
/* ── Phone detail layout (dd- = document detail; mirrors the other detail pages) ── */
.dd-card {
  background: rgb(var(--v-theme-surface));
  border: 1px solid var(--v-billy-border, #e2e4e9);
  border-radius: 16px;
  padding: 16px;
  margin-bottom: 12px;
}
.dd-label {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.6));
}
.dd-value {
  margin-top: 2px;
  font-size: 0.9375rem;
  overflow-wrap: anywhere;
}
.dd-hero__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.dd-hero__number {
  min-width: 0;
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.3;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}
.dd-hero__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding-top: 2px;
}
.dd-hero__client {
  margin-top: 2px;
  font-size: 0.9375rem;
  color: var(--v-billy-text-2, rgba(var(--v-theme-on-surface), 0.75));
  overflow-wrap: anywhere;
}
.dd-hero__total {
  margin-top: 2px;
  font-size: 1.875rem;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.dd-hero__split {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
}
.dd-hero__figure {
  margin-top: 2px;
  font-size: 1rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.dd-hero__meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--v-billy-border, #e2e4e9);
}
.dd-hero__meta > :nth-child(2n) {
  text-align: right;
}
.dd-hero__meta > .dd-hero__meta-wide {
  grid-column: 1 / -1;
  text-align: left;
}
.dd-link {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
  text-decoration: none;
}
.dd-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}
/* Side by side when the labels fit, each full width when they don't (long
   translations) — a primary label is never clipped. */
.dd-actions__primary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.dd-actions__primary:empty {
  display: none;
}
.dd-actions__primary > .v-btn {
  flex: 1 1 auto;
  height: 48px !important;
  border-radius: 14px;
}
.dd-actions__wide {
  width: 100%;
  height: 44px !important;
  border-radius: 14px;
}
.dd-section-title {
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.6));
  margin-bottom: 4px;
}
.dd-line {
  padding: 12px 0;
  border-bottom: 1px solid var(--v-billy-border, #e2e4e9);
}
.dd-line__desc {
  font-size: 0.9375rem;
  line-height: 1.4;
  white-space: pre-line;
  overflow-wrap: anywhere;
}
.dd-line__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-top: 4px;
}
.dd-line__calc {
  min-width: 0;
  font-size: 0.8125rem;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.6));
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.dd-line__total {
  flex: 0 0 auto;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dd-totals {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(var(--v-theme-primary), 0.05);
}
.dd-totals__row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 0;
  font-size: 0.875rem;
  font-variant-numeric: tabular-nums;
}
.dd-totals__row > :last-child {
  text-align: right;
  overflow-wrap: anywhere;
}
.dd-totals__row--grand {
  margin: 4px 0;
  padding: 8px 0;
  border-top: 1px solid var(--v-billy-border, #e2e4e9);
  border-bottom: 1px solid var(--v-billy-border, #e2e4e9);
  font-size: 1.0625rem;
  font-weight: 700;
}
.dd-totals__row--grand:last-child {
  margin-bottom: 0;
  padding-bottom: 2px;
  border-bottom: 0;
}
.dd-totals__row--strong {
  font-weight: 700;
}
.dd-empty {
  padding: 8px 0 2px;
  font-size: 0.875rem;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.6));
}
.dd-pay {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--v-billy-border, #e2e4e9);
}
.dd-pay:last-child {
  border-bottom: 0;
  padding-bottom: 2px;
}
.dd-pay__icon {
  flex: 0 0 auto;
}
.dd-pay__main {
  flex: 1 1 auto;
  min-width: 0;
}
.dd-pay__method {
  font-size: 0.9375rem;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.dd-pay__sub {
  font-size: 0.8125rem;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.6));
  overflow-wrap: anywhere;
}
.dd-pay__amount {
  flex: 0 0 auto;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
