<script setup lang="ts">
/**
 * Quote detail — shows the document + line items and the guarded lifecycle
 * actions (quotes routes): send (draft → sent), accept, decline (sent → …),
 * convert (accepted → converted). All actions send the optimistic-concurrency
 * version via the If-Match header.
 *
 * `convert` creates the DRAFT invoice server-side in the same request and returns
 * `{ quote, invoice }` (not a bare Quote): we keep the converted quote and open the
 * new draft invoice. The converted alert links that invoice by its number.
 */
import { ref, computed, watch, onMounted } from "vue";
import { useClientNames } from "@/composables/useClientNames";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import { apiErrorReason } from "@/utils/validationMessages";
import type { Quote } from "@/types/domain";
import { minorToDisplay } from "@/utils/money";
import StatusChip from "@/components/StatusChip.vue";
import AppCard from "@/components/AppCard.vue";
import DocumentActions from "@/components/DocumentActions.vue";
import InvoiceLink from "@/components/InvoiceLink.vue";
import PageHeader from "@/components/PageHeader.vue";
import { confirm } from "@/composables/useConfirm";
import { useIsMobile } from "@/composables/useIsMobile";

const { t } = useI18n();

interface ConvertResponse {
  quote: Quote;
  /** The draft invoice created by the conversion (id + number; number is null until finalize). */
  invoice: { id: string; invoiceNumber?: string | null; status?: string };
}

const route = useRoute();
const router = useRouter();
const isMobile = useIsMobile();
const id = computed<string>(() => route.params.id as string);

const quote = ref<Quote | null>(null);
const { resolve: resolveClientNames, nameOf: clientNameOf } = useClientNames();
// Resolve the client display name once the document is loaded.
watch(quote, (v) => {
  if (v?.clientId) void resolveClientNames([v.clientId]);
});
const loading = ref(false);
const errorMessage = ref<string | null>(null);
const actionError = ref<string | null>(null);
const acting = ref(false);

const isDraft = computed<boolean>(() => quote.value?.status === "draft");
const isSent = computed<boolean>(() => quote.value?.status === "sent");
const isAccepted = computed<boolean>(() => quote.value?.status === "accepted");
// Convert is offered for accepted quotes — and for a quote the old flow marked
// "converted" without ever creating its invoice (the server repairs it).
const canConvert = computed<boolean>(
  () => isAccepted.value || (quote.value?.status === "converted" && !quote.value.convertedInvoiceId),
);

const load = async (): Promise<void> => {
  loading.value = true;
  errorMessage.value = null;
  try {
    quote.value = await api.get<Quote>(`/v1/quotes/${id.value}`);
  } catch (err) {
    quote.value = null;
    errorMessage.value =
      err instanceof ApiError
        ? t("quotes.loadOneError", { code: apiErrorReason(err) })
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
        ? t("common.actionFailed", { code: apiErrorReason(err) })
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
  let invoiceId: string | null = null;
  await runAction(async () => {
    const res = await api.post<ConvertResponse>(`/v1/quotes/${id.value}/convert`, undefined, {
      ifMatch: quote.value!.version,
    });
    invoiceId = res.invoice?.id ?? res.quote.convertedInvoiceId ?? null;
    return res.quote;
  });
  // Open the new draft invoice (the quote now shows the "converted" link back to it).
  if (invoiceId) await router.push({ name: "invoice-detail", params: { id: invoiceId } });
};

onMounted(() => {
  void load();
});
</script>

<template>
  <div>
    <PageHeader :title="t('quotes.detailTitle')" back>
      <!-- Phone: Edit sits on the title row (drafts only). -->
      <template #mobile-actions>
        <v-btn
          v-if="quote && isDraft"
          icon="mdi-pencil"
          variant="text"
          :aria-label="t('common.edit')"
          :to="{ name: 'quote-edit', params: { id: quote.id } }"
        />
      </template>
    </PageHeader>

    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
      <template #append>
        <v-btn color="primary" size="small" @click="load">{{ t("common.retry") }}</v-btn>
      </template>
    </v-alert>

    <v-card v-if="loading" variant="outlined" rounded="lg" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </v-card>

    <template v-else-if="quote">
      <v-alert v-if="actionError" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
        {{ actionError }}
      </v-alert>

      <!-- Phone: hero summary card + line cards. Desktop markup below is untouched. -->
      <template v-if="isMobile">
        <section class="dm-card dm-hero">
          <div class="dm-hero__head">
            <div class="dm-hero__title">{{ quote.quoteNumber ?? t("quotes.draftUnnumbered") }}</div>
            <StatusChip :status="quote.status" />
          </div>
          <div class="dm-hero__client">{{ clientNameOf(quote.clientId) ?? "\u2014" }}</div>

          <div class="dm-hero__amount">
            <div class="dm-label">{{ t("quotes.totals.total") }}</div>
            <div class="dm-hero__total">{{ minorToDisplay(quote.grandTotalMinor, quote.currency) }}</div>
          </div>

          <div class="dm-meta">
            <div>
              <div class="dm-label">{{ t("quotes.detail.issueDate") }}</div>
              <div class="dm-meta__value">{{ quote.issueDate || "\u2014" }}</div>
            </div>
            <div>
              <div class="dm-label">{{ t("quotes.detail.expiryDate") }}</div>
              <div class="dm-meta__value">{{ quote.expiryDate || "\u2014" }}</div>
            </div>
          </div>

          <!-- Converted: link to the invoice instead of printing its raw id. -->
          <div v-if="quote.convertedInvoiceId" class="dm-hero__note">
            <v-icon icon="mdi-check-circle-outline" color="success" size="small" />
            <span class="dm-hero__note-text">{{ t("quotes.convertedShort") }}</span>
            <v-btn
              variant="text"
              color="primary"
              append-icon="mdi-chevron-right"
              :to="{ name: 'invoice-detail', params: { id: quote.convertedInvoiceId } }"
            >
              {{ t("quotes.viewInvoice") }}
            </v-btn>
          </div>
        </section>

        <!-- Lifecycle: one prominent action for the current state, then the
             document actions (Preview / Print / Download). -->
        <div class="dm-actions">
          <div v-if="isDraft || isSent || canConvert" class="dm-actions__primary">
            <v-btn v-if="isDraft" color="primary" variant="flat" prepend-icon="mdi-send-outline" :loading="acting" @click="send">
              {{ t("quotes.send") }}
            </v-btn>
            <template v-if="isSent">
              <v-btn color="success" variant="flat" prepend-icon="mdi-check" :loading="acting" @click="accept">
                {{ t("quotes.accept") }}
              </v-btn>
              <v-btn color="error" variant="tonal" :disabled="acting" @click="decline">
                {{ t("quotes.decline") }}
              </v-btn>
            </template>
            <v-btn v-if="canConvert" color="primary" variant="flat" prepend-icon="mdi-file-swap-outline" :loading="acting" @click="convert">
              {{ t("quotes.convert") }}
            </v-btn>
          </div>
          <DocumentActions document-type="quote" :document-id="quote.id" />
        </div>

        <section class="dm-card">
          <div class="dm-label">{{ t("quotes.lineItems") }}</div>
          <div v-for="(li, i) in quote.lineItems" :key="i" class="dm-line">
            <div class="dm-line__desc">{{ li.description }}</div>
            <div class="dm-line__row">
              <span class="dm-line__calc">{{ li.quantity }} &times; {{ minorToDisplay(li.unitPriceMinor, quote.currency) }}</span>
              <span class="dm-line__total">{{ minorToDisplay(li.lineTotalMinor, quote.currency) }}</span>
            </div>
          </div>
          <div class="dm-totals">
            <div class="dm-totals__row">
              <span>{{ t("quotes.totals.subtotal") }}</span><span>{{ minorToDisplay(quote.subtotalMinor, quote.currency) }}</span>
            </div>
            <div class="dm-totals__row">
              <span>{{ t("quotes.totals.tax") }}</span><span>{{ minorToDisplay(quote.taxMinor, quote.currency) }}</span>
            </div>
            <div class="dm-totals__row dm-totals__row--grand">
              <span>{{ t("quotes.totals.total") }}</span><span>{{ minorToDisplay(quote.grandTotalMinor, quote.currency) }}</span>
            </div>
          </div>
        </section>
      </template>

      <template v-else>
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
          <!-- The {id} slot is the invoice NUMBER as a link, never the raw id. -->
          <i18n-t keypath="quotes.converted" tag="span">
            <template #id><InvoiceLink :invoice-id="quote.convertedInvoiceId" /></template>
          </i18n-t>
        </v-alert>

        <v-row>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("quotes.detail.client") }}</div>{{ clientNameOf(quote.clientId) ?? "\u2014" }}</v-col>
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
              color="primary"
              prepend-icon="mdi-pencil"
              :to="{ name: 'quote-edit', params: { id: quote.id } }"
            >
              {{ t("common.edit") }}
            </v-btn>
            <v-btn v-if="isDraft" color="primary" :loading="acting" @click="send">{{ t("quotes.send") }}</v-btn>
            <v-btn v-if="isSent" color="success" :loading="acting" @click="accept">{{ t("quotes.accept") }}</v-btn>
            <v-btn v-if="isSent" color="error" :loading="acting" @click="decline">
              {{ t("quotes.decline") }}
            </v-btn>
            <v-btn v-if="canConvert" color="primary" :loading="acting" @click="convert">
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
    </template>
  </div>
</template>


<style scoped>
/* ── Phone detail layout (isMobile branch only) ───────────────────────── */
.dm-card {
  background: rgb(var(--v-theme-surface));
  border: 1px solid var(--v-billy-border, rgba(0, 0, 0, 0.12));
  border-radius: 16px;
  padding: 16px;
  margin-bottom: 12px;
}
.dm-label {
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.4;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.55));
}
.dm-hero__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.dm-hero__title {
  min-width: 0;
  font-size: 1.125rem;
  font-weight: 700;
  line-height: 1.35;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}
.dm-hero__client {
  margin-top: 2px;
  font-size: 0.9375rem;
  line-height: 1.4;
  color: var(--v-billy-text-2, rgba(var(--v-theme-on-surface), 0.7));
  overflow-wrap: anywhere;
}
.dm-hero__amount {
  margin-top: 16px;
}
.dm-hero__total {
  font-size: 1.875rem;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.dm-hero__note {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 14px;
  padding: 6px 4px 6px 12px;
  border-radius: 12px;
  background: rgba(var(--v-theme-success), 0.08);
  font-size: 0.875rem;
}
.dm-hero__note-text {
  flex: 1 1 auto;
  min-width: 0;
}
.dm-hero__note > .v-btn {
  margin-left: auto;
}
.dm-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--v-billy-border, rgba(0, 0, 0, 0.12));
}
.dm-meta__value {
  margin-top: 2px;
  font-size: 0.9375rem;
  line-height: 1.35;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
/* Lifecycle actions under the hero: primary row, then Preview/Print/Download. */
.dm-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}
.dm-actions__primary {
  display: flex;
  gap: 8px;
}
.dm-actions__primary > .v-btn {
  flex: 1 1 0;
  min-width: 0;
  height: 48px !important;
  border-radius: 14px;
}
.dm-line {
  padding: 12px 0;
  border-bottom: 1px solid var(--v-billy-border, rgba(0, 0, 0, 0.12));
}
.dm-line__desc {
  font-size: 0.9375rem;
  line-height: 1.4;
  white-space: pre-line;
  overflow-wrap: anywhere;
}
.dm-line__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-top: 4px;
}
.dm-line__calc {
  min-width: 0;
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.55));
  overflow-wrap: anywhere;
}
.dm-line__total {
  flex: 0 0 auto;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dm-totals {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(var(--v-theme-primary), 0.05);
}
.dm-totals__row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 0;
  font-size: 0.875rem;
  font-variant-numeric: tabular-nums;
}
.dm-totals__row--grand {
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--v-billy-border, rgba(0, 0, 0, 0.12));
  font-size: 1.0625rem;
  font-weight: 700;
}
</style>
