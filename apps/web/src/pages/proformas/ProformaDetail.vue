<script setup lang="ts">
/**
 * Proforma detail — shows the (non-fiscal) document + line items and the guarded
 * lifecycle actions (proforma routes): issue (draft → issued, assigns PRO-
 * number) and void (→ terminal). Both send the optimistic-concurrency `version`
 * via If-Match (the routes require it), mirroring InvoiceDetail's finalize/void.
 */
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import type { Proforma, Invoice } from "@/types/domain";
import { minorToDisplay } from "@/utils/money";
import StatusChip from "@/components/StatusChip.vue";
import AppCard from "@/components/AppCard.vue";
import DocumentActions from "@/components/DocumentActions.vue";
import { confirm } from "@/composables/useConfirm";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const id = computed<string>(() => route.params.id as string);

const proforma = ref<Proforma | null>(null);
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
      err instanceof ApiError ? t("proformas.loadError", { code: err.code }) : t("proformas.loadErrorGeneric");
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
    actionError.value = err instanceof ApiError ? t("common.actionFailed", { code: err.code }) : t("common.actionFailedGeneric");
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
      err instanceof ApiError ? t("common.actionFailed", { code: err.code }) : t("common.actionFailedGeneric");
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
    <div class="d-flex align-center mb-4" style="gap: 12px">
      <v-btn icon="mdi-arrow-left" variant="text" :aria-label="t('common.back')" @click="router.back()" />
      <h1 class="text-h5">{{ t("proformas.detailTitle") }}</h1>
    </div>

    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
      <template #append>
        <v-btn variant="text" size="small" @click="load">{{ t("proformas.retry") }}</v-btn>
      </template>
    </v-alert>

    <v-card v-if="loading" variant="outlined" rounded="lg" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </v-card>

    <template v-else-if="proforma">
      <v-alert v-if="actionError" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
        {{ actionError }}
      </v-alert>

      <AppCard>
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
          {{ t("proformas.converted", { id: proforma.convertedInvoiceId }) }}
        </v-alert>

        <v-row>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("proformas.fields.client") }}</div>{{ proforma.clientId }}</v-col>
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
              variant="text"
              prepend-icon="mdi-pencil"
              :to="{ name: 'proforma-edit', params: { id: proforma.id } }"
            >
              {{ t("common.edit") }}
            </v-btn>
            <v-btn v-if="isDraft" color="primary" :loading="acting" @click="issue">{{ t("proformas.issue") }}</v-btn>
            <v-btn
              v-if="isIssued && !proforma.convertedInvoiceId"
              color="primary"
              variant="outlined"
              prepend-icon="mdi-file-move-outline"
              :loading="converting"
              @click="convert"
            >
              {{ t("proformas.convert") }}
            </v-btn>
            <v-btn v-if="canVoid" color="error" variant="outlined" :loading="acting" @click="voidProforma">
              {{ t("proformas.void") }}
            </v-btn>
          </div>
        </template>
      </AppCard>

      <v-card variant="outlined" rounded="lg">
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
