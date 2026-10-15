<script setup lang="ts">
/**
 * Credit note detail — shows the document + line items and the guarded lifecycle
 * actions (credit-notes routes): issue (draft → issued, assigns CN- number) and
 * void (→ terminal). Both send the optimistic-concurrency `version` via If-Match
 * (the routes require it), mirroring InvoiceDetail's finalize/void.
 */
import { ref, computed, watch, onMounted } from "vue";
import { useClientNames } from "@/composables/useClientNames";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { api, ApiError } from "@/api/client";
import { apiErrorReason } from "@/utils/validationMessages";
import type { CreditNote } from "@/types/domain";
import { minorToDisplay } from "@/utils/money";
import StatusChip from "@/components/StatusChip.vue";
import AppCard from "@/components/AppCard.vue";
import PageHeader from "@/components/PageHeader.vue";
import { useIsMobile } from "@/composables/useIsMobile";
import DocumentActions from "@/components/DocumentActions.vue";
import { confirm } from "@/composables/useConfirm";
import { useToast } from "@/composables/useToast";
import { useEInvoicing } from "@/stores/einvoicing";
import { isApiCode } from "@/composables/useEInvoice";
import EInvoicePanel from "@/components/einvoicing/EInvoicePanel.vue";
import EInvoiceSentChip from "@/components/einvoicing/EInvoiceSentChip.vue";
import EInvoiceActionButton from "@/components/einvoicing/EInvoiceActionButton.vue";
import type { EInvoiceInfo } from "@/types/domain";

const { t } = useI18n();
const route = useRoute();
const einvoicing = useEInvoicing();
const { toast } = useToast();
const isMobile = useIsMobile();
const id = computed<string>(() => route.params.id as string);

const creditNote = ref<CreditNote | null>(null);
const { resolve: resolveClientNames, nameOf: clientNameOf } = useClientNames();
// Resolve the client display name once the document is loaded.
watch(creditNote, (v) => {
  if (v?.clientId) void resolveClientNames([v.clientId]);
});
const loading = ref(false);
const errorMessage = ref<string | null>(null);
const actionError = ref<string | null>(null);
const acting = ref(false);

// A credit note already issued at SdI cannot be voided (issue a new document instead).
const legallyIssued = ref(false);
const einvoiceInfo = ref<EInvoiceInfo | null>(null);
// The SdI panel is collapsed by default; it opens by itself (once) when something needs attention.
const einvoiceOpen = ref(false);
let einvoiceAutoOpened = false;
const onEInvoiceLoaded = (info: EInvoiceInfo): void => {
  legallyIssued.value = info.legallyIssued;
  einvoiceInfo.value = info;
  if (!einvoiceAutoOpened && (info.status === "rejected" || info.status === "failed")) {
    einvoiceAutoOpened = true;
    einvoiceOpen.value = true;
  }
};

const isDraft = computed<boolean>(() => creditNote.value?.status === "draft");
const canVoid = computed<boolean>(
  () => creditNote.value != null && creditNote.value.status !== "void",
);

const load = async (): Promise<void> => {
  loading.value = true;
  errorMessage.value = null;
  try {
    creditNote.value = await api.get<CreditNote>(`/v1/credit-notes/${id.value}`);
  } catch (err) {
    creditNote.value = null;
    errorMessage.value =
      err instanceof ApiError ? t("creditNotes.loadError", { code: apiErrorReason(err) }) : t("creditNotes.loadErrorGeneric");
  } finally {
    loading.value = false;
  }
};

const runAction = async (fn: () => Promise<CreditNote>): Promise<void> => {
  actionError.value = null;
  acting.value = true;
  try {
    creditNote.value = await fn();
  } catch (err) {
    if (isApiCode(err, "EINVOICE_LEGALLY_ISSUED")) {
      legallyIssued.value = true;
      toast.error(t("einvoicing.errors.legallyIssued"));
    } else {
      actionError.value = err instanceof ApiError ? t("common.actionFailed", { code: apiErrorReason(err) }) : t("common.actionFailedGeneric");
    }
  } finally {
    acting.value = false;
  }
};

const issue = async (): Promise<void> => {
  if (!creditNote.value) return;
  const ok = await confirm({
    title: t("creditNotes.confirm.issueTitle"),
    message: t("creditNotes.confirm.issueMessage"),
    confirmText: t("creditNotes.issue"),
  });
  if (!ok) return;
  await runAction(() =>
    api.post<CreditNote>(`/v1/credit-notes/${id.value}/issue`, undefined, { ifMatch: creditNote.value!.version }),
  );
};
const voidNote = async (): Promise<void> => {
  if (!creditNote.value) return;
  const ok = await confirm({
    title: t("creditNotes.confirm.voidTitle"),
    message: t("creditNotes.confirm.voidMessage"),
    confirmText: t("creditNotes.void"),
    tone: "error",
  });
  if (!ok) return;
  await runAction(() =>
    api.post<CreditNote>(`/v1/credit-notes/${id.value}/void`, undefined, { ifMatch: creditNote.value!.version }),
  );
};

onMounted(() => {
  void einvoicing.load();
  void load();
});
</script>

<template>
  <div>
    <PageHeader :title="t('creditNotes.detailTitle')" back>
      <!-- Phone: the destructive Void lives in an overflow menu. -->
      <template v-if="creditNote && !loading && canVoid" #mobile-actions>
        <v-menu location="bottom end">
          <template #activator="{ props: menuProps }">
            <v-btn v-bind="menuProps" icon="mdi-dots-vertical" variant="text" :aria-label="t('rowActions.menu')" data-test="credit-note-more" />
          </template>
          <v-list density="comfortable" min-width="220">
            <v-list-item
              prepend-icon="mdi-cancel"
              base-color="error"
              :title="t('creditNotes.void')"
              :subtitle="legallyIssued ? t('einvoicing.errors.legallyIssued') : undefined"
              :disabled="legallyIssued"
              @click="voidNote"
            />
          </v-list>
        </v-menu>
      </template>
    </PageHeader>

    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
      <template #append>
        <v-btn color="primary" size="small" @click="load">{{ t("creditNotes.retry") }}</v-btn>
      </template>
    </v-alert>

    <v-card v-if="loading" variant="outlined" rounded="lg" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </v-card>

    <template v-else-if="creditNote">
      <v-alert v-if="actionError" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
        {{ actionError }}
      </v-alert>

      <!-- ── Phone: hero summary + actions ─────────────────────────────── -->
      <template v-if="isMobile">
        <section class="dd-card dd-hero">
          <div class="dd-hero__head">
            <div class="dd-hero__number">{{ creditNote.creditNoteNumber ?? t("creditNotes.draftUnnumbered") }}</div>
            <div class="dd-hero__chips">
              <StatusChip :status="creditNote.status" />
              <EInvoiceSentChip v-if="einvoicing.enabled" :info="einvoiceInfo" @click="einvoiceOpen = !einvoiceOpen" />
            </div>
          </div>
          <div class="dd-hero__client">{{ clientNameOf(creditNote.clientId) ?? "\u2014" }}</div>

          <div class="dd-label mt-4">{{ t("creditNotes.totals.total") }}</div>
          <div class="dd-hero__total">{{ minorToDisplay(creditNote.grandTotalMinor, creditNote.currency) }}</div>

          <div class="dd-hero__meta">
            <div>
              <div class="dd-label">{{ t("creditNotes.fields.issueDate") }}</div>
              <div class="dd-value">{{ creditNote.issueDate }}</div>
            </div>
            <div>
              <div class="dd-label">{{ t("creditNotes.fields.creditedInvoice") }}</div>
              <div class="dd-value">
                <router-link
                  v-if="creditNote.creditedInvoiceNumber"
                  :to="{ name: 'invoice-detail', params: { id: creditNote.creditedInvoiceId } }"
                  class="dd-link"
                >
                  {{ creditNote.creditedInvoiceNumber }}
                </router-link>
                <template v-else>&mdash;</template>
              </div>
            </div>
            <div v-if="creditNote.reason" class="dd-hero__meta-wide">
              <div class="dd-label">{{ t("creditNotes.fields.reason") }}</div>
              <div class="dd-value">{{ creditNote.reason }}</div>
            </div>
          </div>
        </section>

        <div class="dd-actions">
          <div class="dd-actions__primary">
            <v-btn v-if="isDraft" color="primary" variant="flat" size="large" :loading="acting" @click="issue">
              {{ t("creditNotes.issue") }}
            </v-btn>
            <v-btn
              v-if="isDraft"
              color="primary"
              variant="tonal"
              size="large"
              prepend-icon="mdi-pencil"
              :to="{ name: 'credit-note-edit', params: { id: creditNote.id } }"
            >
              {{ t("common.edit") }}
            </v-btn>
          </div>
          <DocumentActions document-type="credit-note" :document-id="creditNote.id" />
          <EInvoiceActionButton
            v-if="einvoicing.enabled && !isDraft"
            :info="einvoiceInfo"
            :open="einvoiceOpen"
            class="dd-actions__wide"
            @toggle="einvoiceOpen = !einvoiceOpen"
          />
        </div>
      </template>

      <AppCard v-else>
        <template #header>
          <div class="text-h6 mr-3">{{ creditNote.creditNoteNumber ?? t("creditNotes.draftUnnumbered") }}</div>
          <StatusChip :status="creditNote.status" />
          <EInvoiceSentChip v-if="einvoicing.enabled" :info="einvoiceInfo" @click="einvoiceOpen = !einvoiceOpen" />
        </template>

        <v-row>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("creditNotes.fields.client") }}</div>{{ clientNameOf(creditNote.clientId) ?? "\u2014" }}</v-col>
          <v-col cols="6" md="3">
            <div class="text-caption">{{ t("creditNotes.fields.creditedInvoice") }}</div>
            {{ creditNote.creditedInvoiceNumber ?? creditNote.creditedInvoiceId }}
          </v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("creditNotes.fields.currency") }}</div>{{ creditNote.currency }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("creditNotes.fields.issueDate") }}</div>{{ creditNote.issueDate }}</v-col>
          <v-col v-if="creditNote.reason" cols="12"><div class="text-caption">{{ t("creditNotes.fields.reason") }}</div>{{ creditNote.reason }}</v-col>
        </v-row>

        <template #actions>
          <div class="d-flex align-center" style="gap: 8px; flex-wrap: wrap; width: 100%">
            <DocumentActions document-type="credit-note" :document-id="creditNote.id" />
            <v-spacer />
            <v-btn
              v-if="isDraft"
              color="primary"
              prepend-icon="mdi-pencil"
              :to="{ name: 'credit-note-edit', params: { id: creditNote.id } }"
            >
              {{ t("common.edit") }}
            </v-btn>
            <v-btn v-if="isDraft" color="primary" :loading="acting" @click="issue">{{ t("creditNotes.issue") }}</v-btn>
            <EInvoiceActionButton
              v-if="einvoicing.enabled && !isDraft"
              :info="einvoiceInfo"
              :open="einvoiceOpen"
              @toggle="einvoiceOpen = !einvoiceOpen"
            />
            <v-btn
              v-if="canVoid"
              color="error"
              :loading="acting"
              :disabled="legallyIssued"
              :title="legallyIssued ? t('einvoicing.errors.legallyIssued') : undefined"
              @click="voidNote"
            >
              {{ t("creditNotes.void") }}
            </v-btn>
          </div>
        </template>
      </AppCard>

      <v-expand-transition>
        <div v-show="einvoiceOpen" data-test="einvoice-collapse">
        <EInvoicePanel
          v-if="einvoicing.enabled && !isDraft"
          kind="credit-notes"
          :document-id="creditNote.id"
          :client-id="creditNote.clientId"
          :refresh-key="creditNote.version"
          @loaded="onEInvoiceLoaded"
        />
        </div>
      </v-expand-transition>

      <!-- ── Phone: line cards + totals ──────────────────────────────── -->
      <section v-if="isMobile" class="dd-card">
        <div class="dd-section-title">{{ t("creditNotes.lineItems") }}</div>
        <div v-for="(li, i) in creditNote.lineItems" :key="i" class="dd-line">
          <div class="dd-line__desc">{{ li.description }}</div>
          <div class="dd-line__row">
            <span class="dd-line__calc">
              {{ li.quantity }} × {{ minorToDisplay(li.unitPriceMinor, creditNote.currency) }}
              <template v-if="li.discountRate"> · −{{ li.discountRate }}%</template>
              <template v-if="li.taxRate != null"> · {{ t("creditNotes.totals.tax") }} {{ li.taxRate }}%</template>
            </span>
            <span class="dd-line__total">{{ minorToDisplay(li.lineTotalMinor, creditNote.currency) }}</span>
          </div>
        </div>
        <div class="dd-totals">
          <div class="dd-totals__row">
            <span>{{ t("creditNotes.totals.subtotal") }}</span><span>{{ minorToDisplay(creditNote.subtotalMinor, creditNote.currency) }}</span>
          </div>
          <div class="dd-totals__row">
            <span>{{ t("creditNotes.totals.tax") }}</span><span>{{ minorToDisplay(creditNote.taxMinor, creditNote.currency) }}</span>
          </div>
          <div class="dd-totals__row dd-totals__row--grand">
            <span>{{ t("creditNotes.totals.total") }}</span><span>{{ minorToDisplay(creditNote.grandTotalMinor, creditNote.currency) }}</span>
          </div>
        </div>
      </section>

      <v-card v-else variant="outlined" rounded="lg">
        <v-card-text>
        <div class="text-subtitle-2 mb-2">{{ t("creditNotes.lineItems") }}</div>
        <v-table density="compact">
          <thead>
            <tr>
              <th>{{ t("creditNotes.lineCols.description") }}</th>
              <th class="text-right">{{ t("creditNotes.lineCols.qty") }}</th>
              <th class="text-right">{{ t("creditNotes.lineCols.unit") }}</th>
              <th class="text-right">{{ t("creditNotes.lineCols.total") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(li, i) in creditNote.lineItems" :key="i">
              <td>{{ li.description }}</td>
              <td class="text-right">{{ li.quantity }}</td>
              <td class="text-right">{{ minorToDisplay(li.unitPriceMinor, creditNote.currency) }}</td>
              <td class="text-right">{{ minorToDisplay(li.lineTotalMinor, creditNote.currency) }}</td>
            </tr>
          </tbody>
        </v-table>
        <v-divider class="my-3" />
        <div class="d-flex justify-end">
          <div style="min-width: 240px">
            <div class="d-flex justify-space-between">
              <span>{{ t("creditNotes.totals.subtotal") }}</span><span>{{ minorToDisplay(creditNote.subtotalMinor, creditNote.currency) }}</span>
            </div>
            <div class="d-flex justify-space-between">
              <span>{{ t("creditNotes.totals.tax") }}</span><span>{{ minorToDisplay(creditNote.taxMinor, creditNote.currency) }}</span>
            </div>
            <div class="d-flex justify-space-between text-subtitle-1 font-weight-medium">
              <span>{{ t("creditNotes.totals.total") }}</span><span>{{ minorToDisplay(creditNote.grandTotalMinor, creditNote.currency) }}</span>
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
