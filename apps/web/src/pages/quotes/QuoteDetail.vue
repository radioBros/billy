<script setup lang="ts">
/**
 * Quote detail — shows the document + line items and the guarded lifecycle
 * actions (quotes routes): send (draft → sent), accept, decline (sent → …),
 * convert (accepted → converted). All actions send the optimistic-concurrency
 * version via the If-Match header.
 *
 * `convert` returns `{ quote, invoicePayload }` (not a bare Quote) — the created
 * invoice is a SEPARATE POST /v1/invoices/from-quote step owned elsewhere; here
 * we just refresh the quote from the wrapper and surface the converted state.
 */
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import type { Quote } from "@/types/domain";
import { minorToDisplay } from "@/utils/money";
import StatusChip from "@/components/StatusChip.vue";
import AppCard from "@/components/AppCard.vue";
import DocumentActions from "@/components/DocumentActions.vue";
import { confirm } from "@/composables/useConfirm";

const { t } = useI18n();

interface ConvertResponse {
  quote: Quote;
  invoicePayload?: unknown;
}

const route = useRoute();
const router = useRouter();
const id = computed<string>(() => route.params.id as string);

const quote = ref<Quote | null>(null);
const loading = ref(false);
const errorMessage = ref<string | null>(null);
const actionError = ref<string | null>(null);
const acting = ref(false);

const isDraft = computed<boolean>(() => quote.value?.status === "draft");
const isSent = computed<boolean>(() => quote.value?.status === "sent");
const isAccepted = computed<boolean>(() => quote.value?.status === "accepted");

const load = async (): Promise<void> => {
  loading.value = true;
  errorMessage.value = null;
  try {
    quote.value = await api.get<Quote>(`/v1/quotes/${id.value}`);
  } catch (err) {
    quote.value = null;
    errorMessage.value =
      err instanceof ApiError
        ? t("quotes.loadOneError", { code: err.code })
        : t("quotes.loadOneErrorGeneric");
  } finally {
    loading.value = false;
  }
};

const runAction = async (fn: () => Promise<Quote>): Promise<void> => {
  actionError.value = null;
  acting.value = true;
  try {
    quote.value = await fn();
  } catch (err) {
    actionError.value =
      err instanceof ApiError
        ? t("common.actionFailed", { code: err.code })
        : t("common.actionFailedGeneric");
  } finally {
    acting.value = false;
  }
};

const send = async (): Promise<void> => {
  if (!quote.value) return;
  const ok = await confirm({
    title: t("quotes.confirm.sendTitle"),
    message: t("quotes.confirm.sendMessage"),
    confirmText: t("quotes.send"),
  });
  if (!ok) return;
  await runAction(() => api.post<Quote>(`/v1/quotes/${id.value}/send`, undefined, { ifMatch: quote.value!.version }));
};
const accept = async (): Promise<void> => {
  if (!quote.value) return;
  const ok = await confirm({
    title: t("quotes.confirm.acceptTitle"),
    message: t("quotes.confirm.acceptMessage"),
    confirmText: t("quotes.accept"),
  });
  if (!ok) return;
  await runAction(() => api.post<Quote>(`/v1/quotes/${id.value}/accept`, undefined, { ifMatch: quote.value!.version }));
};
const decline = async (): Promise<void> => {
  if (!quote.value) return;
  const ok = await confirm({
    title: t("quotes.confirm.declineTitle"),
    message: t("quotes.confirm.declineMessage"),
    confirmText: t("quotes.decline"),
    tone: "error",
  });
  if (!ok) return;
  await runAction(() => api.post<Quote>(`/v1/quotes/${id.value}/decline`, undefined, { ifMatch: quote.value!.version }));
};
const convert = async (): Promise<void> => {
  if (!quote.value) return;
  const ok = await confirm({
    title: t("quotes.confirm.convertTitle"),
    message: t("quotes.confirm.convertMessage"),
    confirmText: t("quotes.convert"),
  });
  if (!ok) return;
  await runAction(async () => {
    const res = await api.post<ConvertResponse>(`/v1/quotes/${id.value}/convert`, undefined, {
      ifMatch: quote.value!.version,
    });
    return res.quote;
  });
};

onMounted(() => {
  void load();
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 12px">
      <v-btn icon="mdi-arrow-left" variant="text" :aria-label="t('common.back')" @click="router.back()" />
      <h1 class="text-h5">{{ t("quotes.detailTitle") }}</h1>
    </div>

    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
      <template #append>
        <v-btn variant="text" size="small" @click="load">{{ t("common.retry") }}</v-btn>
      </template>
    </v-alert>

    <v-card v-if="loading" variant="outlined" rounded="lg" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </v-card>

    <template v-else-if="quote">
      <v-alert v-if="actionError" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
        {{ actionError }}
      </v-alert>

      <AppCard>
        <template #header>
          <div class="text-h6 mr-3">{{ quote.quoteNumber ?? t("quotes.draftUnnumbered") }}</div>
          <StatusChip :status="quote.status" />
        </template>

        <v-alert
          v-if="quote.convertedInvoiceId"
          type="success"
          variant="tonal"
          density="compact"
          class="mb-4"
        >
          {{ t("quotes.converted", { id: quote.convertedInvoiceId }) }}
        </v-alert>

        <v-row>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("quotes.detail.client") }}</div>{{ quote.clientId }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("quotes.detail.currency") }}</div>{{ quote.currency }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("quotes.detail.issueDate") }}</div>{{ quote.issueDate }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("quotes.detail.expiryDate") }}</div>{{ quote.expiryDate }}</v-col>
        </v-row>

        <template #actions>
          <div class="d-flex align-center" style="gap: 8px; flex-wrap: wrap; width: 100%">
            <DocumentActions document-type="quote" :document-id="quote.id" />
            <v-spacer />
            <v-btn
              v-if="isDraft"
              variant="text"
              prepend-icon="mdi-pencil"
              :to="{ name: 'quote-edit', params: { id: quote.id } }"
            >
              {{ t("common.edit") }}
            </v-btn>
            <v-btn v-if="isDraft" color="primary" :loading="acting" @click="send">{{ t("quotes.send") }}</v-btn>
            <v-btn v-if="isSent" color="success" :loading="acting" @click="accept">{{ t("quotes.accept") }}</v-btn>
            <v-btn v-if="isSent" color="error" variant="outlined" :loading="acting" @click="decline">
              {{ t("quotes.decline") }}
            </v-btn>
            <v-btn v-if="isAccepted" color="primary" :loading="acting" @click="convert">
              {{ t("quotes.convert") }}
            </v-btn>
          </div>
        </template>
      </AppCard>

      <v-card variant="outlined" rounded="lg">
        <v-card-text>
        <div class="text-subtitle-2 mb-2">{{ t("quotes.lineItems") }}</div>
        <v-table density="compact">
          <thead>
            <tr>
              <th>{{ t("quotes.lineCols.description") }}</th>
              <th class="text-right">{{ t("quotes.lineCols.qty") }}</th>
              <th class="text-right">{{ t("quotes.lineCols.unit") }}</th>
              <th class="text-right">{{ t("quotes.lineCols.total") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(li, i) in quote.lineItems" :key="i">
              <td>{{ li.description }}</td>
              <td class="text-right">{{ li.quantity }}</td>
              <td class="text-right">{{ minorToDisplay(li.unitPriceMinor, quote.currency) }}</td>
              <td class="text-right">{{ minorToDisplay(li.lineTotalMinor, quote.currency) }}</td>
            </tr>
          </tbody>
        </v-table>
        <v-divider class="my-3" />
        <div class="d-flex justify-end">
          <div style="min-width: 240px">
            <div class="d-flex justify-space-between">
              <span>{{ t("quotes.totals.subtotal") }}</span><span>{{ minorToDisplay(quote.subtotalMinor, quote.currency) }}</span>
            </div>
            <div class="d-flex justify-space-between">
              <span>{{ t("quotes.totals.tax") }}</span><span>{{ minorToDisplay(quote.taxMinor, quote.currency) }}</span>
            </div>
            <div class="d-flex justify-space-between text-subtitle-1 font-weight-medium">
              <span>{{ t("quotes.totals.total") }}</span><span>{{ minorToDisplay(quote.grandTotalMinor, quote.currency) }}</span>
            </div>
          </div>
        </div>
        </v-card-text>
      </v-card>
    </template>
  </div>
</template>
