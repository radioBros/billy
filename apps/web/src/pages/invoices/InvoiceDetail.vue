<script setup lang="ts">
/**
 * Invoice detail — shows the document + line items + payments and exposes the
 * guarded lifecycle actions (invoices routes): finalize (draft → finalized),
 * void, and add-payment. All actions send the optimistic-concurrency `version`
 * in the body. Financial fields may be absent (stripped for restricted users) —
 * minorToDisplay renders a placeholder.
 */
import { ref, computed, watch, onMounted } from "vue";
import { useClientNames } from "@/composables/useClientNames";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import { apiErrorReason } from "@/utils/validationMessages";
import type { Invoice, PaymentMethod, BusinessSettings } from "@/types/domain";
import { minorToDisplay, majorToMinor } from "@/utils/money";
import { enumLabel } from "@/utils/enums";
import StatusChip from "@/components/StatusChip.vue";
import AppCard from "@/components/AppCard.vue";
import DocumentActions from "@/components/DocumentActions.vue";
import SendDocumentModal from "@/components/SendDocumentModal.vue";
import type { SendKind } from "@/composables/useSendDocument";
import { confirm } from "@/composables/useConfirm";
import { useAuthStore } from "@/stores/auth";

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const auth = useAuthStore();
const id = computed<string>(() => route.params.id as string);

const invoice = ref<Invoice | null>(null);
const { resolve: resolveClientNames, nameOf: clientNameOf } = useClientNames();
// Resolve the client display name once the document is loaded.
watch(invoice, (v) => {
  if (v?.clientId) void resolveClientNames([v.clientId]);
});
const loading = ref(false);
const errorMessage = ref<string | null>(null);
const actionError = ref<string | null>(null);
const acting = ref(false);

// add-payment dialog state
const payDialog = ref(false);
const payAmountMajor = ref<number | null>(null);
const payDate = ref(new Date().toISOString().slice(0, 10));
// The selection may be a plain PaymentMethod OR a bank-account sentinel
// (`bank:<label>`); it's resolved to { method, bankAccountLabel } at submit.
const paySelection = ref<string>("bank_transfer");
const payReference = ref("");

// Company registered bank accounts (business settings) — the FIRST group of the
// payment-method dropdown. Loaded once on mount; empty when none configured.
const bankAccounts = ref<{ label: string }[]>([]);
const PAYMENT_METHODS: PaymentMethod[] = [
  "bank_transfer",
  "card",
  "cash",
  "paypal",
  "stripe",
  "direct_debit",
  "other",
];
// Grouped dropdown items: the company's registered bank accounts FIRST (each value
// is a `bank:<label>` sentinel), then a subheader/divider, then the generic payment
// methods. Vuetify renders `{ type: 'subheader' | 'divider' }` sentinels inline.
const PAYMENT_METHOD_ITEMS = computed(() => {
  const items: Array<Record<string, unknown>> = [];
  if (bankAccounts.value.length > 0) {
    items.push({ type: "subheader", title: t("invoices.payDialog.bankAccountsGroup") });
    for (const b of bankAccounts.value) {
      items.push({ title: b.label, value: `bank:${b.label}` });
    }
    items.push({ type: "divider" });
    items.push({ type: "subheader", title: t("invoices.payDialog.otherMethodsGroup") });
  }
  for (const v of PAYMENT_METHODS) {
    items.push({ title: enumLabel(t, "paymentMethod", v), value: v });
  }
  return items;
});

// today (YYYY-MM-DD) — used as the date-picker floor and the schedule default.
const today = new Date().toISOString().slice(0, 10);

const isDraft = computed<boolean>(() => invoice.value?.status === "draft");
const isScheduled = computed<boolean>(() => invoice.value?.status === "scheduled");
// Finalize-now is available while draft OR scheduled (finalizing overrides the schedule).
const canFinalize = computed<boolean>(() => isDraft.value || isScheduled.value);
// Void / add-payment apply only to numbered, post-finalization invoices — never
// to a draft or a still-un-numbered scheduled invoice.
const canVoid = computed<boolean>(
  () =>
    invoice.value != null &&
    invoice.value.status !== "void" &&
    invoice.value.status !== "draft" &&
    invoice.value.status !== "scheduled",
);

// A finalized-or-later invoice can be emailed (resend) + reminded. Draft and
// still-scheduled invoices cannot (the send gate rejects them).
const canSend = computed<boolean>(
  () =>
    invoice.value != null &&
    invoice.value.status !== "draft" &&
    invoice.value.status !== "scheduled",
);

// Delete: unnumbered documents only (draft/scheduled) + the admin capability.
// Finalized invoices are immutable legal records — Void is their exit.
const canDelete = computed<boolean>(
  () =>
    auth.principal?.capabilities.canPermanentlyDelete === true &&
    (isDraft.value || isScheduled.value),
);

const deleteInvoice = async (): Promise<void> => {
  if (!invoice.value) return;
  const ok = await confirm({
    title: t("documents.confirm.deleteTitle"),
    message: t("documents.confirm.deleteMessage", {
      name: invoice.value.invoiceNumber ?? t("documents.draft"),
    }),
    confirmText: t("common.delete"),
    tone: "error",
  });
  if (!ok) return;
  acting.value = true;
  actionError.value = null;
  try {
    await api.del(`/v1/invoices/${id.value}`);
    await router.push({ name: "invoices" });
  } catch (err) {
    actionError.value =
      err instanceof ApiError
        ? t("common.actionFailed", { code: apiErrorReason(err) })
        : t("common.actionFailedGeneric");
  } finally {
    acting.value = false;
  }
};

// send-document modal state (shared for both "Send" and "Send reminder").
const sendModal = ref(false);
const sendKind = ref<SendKind>("invoice");
const openSend = (kind: SendKind): void => {
  sendKind.value = kind;
  sendModal.value = true;
};

// schedule-send dialog state
const scheduleDialog = ref(false);
const scheduleDate = ref(today);

const load = async (): Promise<void> => {
  loading.value = true;
  errorMessage.value = null;
  try {
    invoice.value = await api.get<Invoice>(`/v1/invoices/${id.value}`);
  } catch (err) {
    invoice.value = null;
    errorMessage.value =
      err instanceof ApiError
        ? t("invoices.loadOneError", { code: apiErrorReason(err) })
        : t("invoices.loadOneErrorGeneric");
  } finally {
    loading.value = false;
  }
};

const runAction = async (fn: () => Promise<Invoice>): Promise<void> => {
  actionError.value = null;
  acting.value = true;
  try {
    invoice.value = await fn();
  } catch (err) {
    actionError.value =
      err instanceof ApiError
        ? t("common.actionFailed", { code: apiErrorReason(err) })
        : t("common.actionFailedGeneric");
  } finally {
    acting.value = false;
  }
};

const finalize = async (): Promise<void> => {
  if (!invoice.value) return;
  const ok = await confirm({
    title: t("invoices.confirm.finalizeTitle"),
    message: t("invoices.confirm.finalizeMessage"),
    confirmText: t("invoices.finalize"),
  });
  if (!ok) return;
  await runAction(() =>
    api.post<Invoice>(`/v1/invoices/${id.value}/finalize`, undefined, { ifMatch: invoice.value!.version }),
  );
};

const voidInvoice = async (): Promise<void> => {
  if (!invoice.value) return;
  const ok = await confirm({
    title: t("invoices.confirm.voidTitle"),
    message: t("invoices.confirm.voidMessage"),
    confirmText: t("invoices.void"),
    tone: "error",
  });
  if (!ok) return;
  await runAction(() =>
    api.post<Invoice>(`/v1/invoices/${id.value}/void`, undefined, { ifMatch: invoice.value!.version }),
  );
};

const openScheduleDialog = (): void => {
  scheduleDate.value = invoice.value?.scheduledSendDate ?? today;
  actionError.value = null;
  scheduleDialog.value = true;
};

const submitSchedule = async (): Promise<void> => {
  if (!invoice.value) return;
  // Guard: the schedule date must be today or later (mirrors the API rule).
  if (!scheduleDate.value || scheduleDate.value < today) {
    actionError.value = t("invoices.schedule.dateError");
    return;
  }
  await runAction(() =>
    api.post<Invoice>(
      `/v1/invoices/${id.value}/schedule`,
      { scheduledSendDate: scheduleDate.value },
      { ifMatch: invoice.value!.version },
    ),
  );
  if (!actionError.value) scheduleDialog.value = false;
};

const unschedule = async (): Promise<void> => {
  if (!invoice.value) return;
  const ok = await confirm({
    title: t("invoices.confirm.unscheduleTitle"),
    message: t("invoices.confirm.unscheduleMessage"),
    confirmText: t("invoices.schedule.unscheduleAction"),
    tone: "warning",
  });
  if (!ok) return;
  await runAction(() =>
    api.post<Invoice>(`/v1/invoices/${id.value}/unschedule`, undefined, {
      ifMatch: invoice.value!.version,
    }),
  );
};

const submitPayment = async (): Promise<void> => {
  if (!invoice.value) return;
  const amountMinor = majorToMinor(payAmountMajor.value);
  if (amountMinor === null || amountMinor <= 0) {
    actionError.value = t("invoices.positiveAmount");
    return;
  }
  // Resolve the selection: a `bank:<label>` sentinel → method=bank_transfer plus the
  // account label; otherwise it's a plain PaymentMethod with no bank account.
  const sel = paySelection.value;
  const isBank = sel.startsWith("bank:");
  const method: PaymentMethod = isBank ? "bank_transfer" : (sel as PaymentMethod);
  const bankAccountLabel = isBank ? sel.slice("bank:".length) : null;
  await runAction(() =>
    api.post<Invoice>(
      `/v1/invoices/${id.value}/payments`,
      {
        amountMinor,
        date: payDate.value,
        method,
        reference: payReference.value.trim() || null,
        bankAccountLabel,
      },
      { ifMatch: invoice.value!.version },
    ),
  );
  if (!actionError.value) {
    payDialog.value = false;
    payAmountMajor.value = null;
    payReference.value = "";
  }
};

onMounted(() => {
  void load();
  // Best-effort: load the company's registered bank accounts for the payment
  // dropdown's first group. Any failure (permissions / unset) → no bank group.
  void api
    .get<BusinessSettings>("/v1/settings/business")
    .then((s) => {
      bankAccounts.value = (s.bankAccounts ?? []).filter((b) => b.label && b.label.trim().length > 0);
    })
    .catch(() => {
      bankAccounts.value = [];
    });
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 12px">
      <v-btn icon="mdi-arrow-left" variant="text" :aria-label="t('common.back')" @click="router.back()" />
      <h1 class="text-h5">{{ t("invoices.detailTitle") }}</h1>
    </div>

    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
      <template #append>
        <v-btn color="primary" size="small" @click="load">{{ t("common.retry") }}</v-btn>
      </template>
    </v-alert>

    <v-card v-if="loading" variant="outlined" rounded="lg" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </v-card>

    <template v-else-if="invoice">
      <v-alert v-if="actionError" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
        {{ actionError }}
      </v-alert>

      <AppCard>
        <template #header>
          <div class="text-h6 mr-3">{{ invoice.invoiceNumber ?? t("invoices.draftUnnumbered") }}</div>
          <StatusChip :status="invoice.status" />
        </template>

        <v-alert
          v-if="isScheduled && invoice.scheduledSendDate"
          type="warning"
          variant="tonal"
          density="compact"
          class="mb-4"
          icon="mdi-calendar-clock"
        >
          {{ t("invoices.schedule.banner", { date: invoice.scheduledSendDate }) }}
        </v-alert>

        <v-row>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("invoices.detail.client") }}</div>{{ clientNameOf(invoice.clientId) ?? "\u2014" }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("invoices.detail.currency") }}</div>{{ invoice.currency }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("invoices.detail.issueDate") }}</div>{{ invoice.issueDate }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("invoices.detail.dueDate") }}</div>{{ invoice.dueDate }}</v-col>
        </v-row>

        <template #actions>
          <div class="d-flex align-center" style="gap: 8px; flex-wrap: wrap; width: 100%">
            <DocumentActions document-type="invoice" :document-id="invoice.id" />
            <v-spacer />
            <v-btn v-if="canSend" color="primary" prepend-icon="mdi-email-outline" :loading="acting" @click="openSend('invoice')">
              {{ t("invoices.send") }}
            </v-btn>
            <v-btn v-if="canSend" color="secondary" prepend-icon="mdi-email-alert-outline" :loading="acting" @click="openSend('reminder')">
              {{ t("invoices.sendReminder") }}
            </v-btn>
            <v-btn v-if="isDraft" color="primary" prepend-icon="mdi-pencil" :to="{ name: 'invoice-edit', params: { id: invoice.id } }">
              {{ t("common.edit") }}
            </v-btn>
            <v-btn v-if="isDraft" color="primary" prepend-icon="mdi-calendar-clock" :loading="acting" @click="openScheduleDialog">
              {{ t("invoices.schedule.action") }}
            </v-btn>
            <v-btn v-if="isScheduled" color="primary" prepend-icon="mdi-calendar-remove" :loading="acting" @click="unschedule">
              {{ t("invoices.schedule.unscheduleAction") }}
            </v-btn>
            <v-btn v-if="canFinalize" color="primary" :loading="acting" @click="finalize">{{ t("invoices.finalize") }}</v-btn>
            <v-btn v-if="canVoid" color="error" :loading="acting" @click="voidInvoice">
              {{ t("invoices.void") }}
            </v-btn>
            <v-btn v-if="canVoid" color="primary" :loading="acting" @click="payDialog = true">
              {{ t("invoices.addPayment") }}
            </v-btn>
            <v-btn
              v-if="canDelete"
              color="error"
              variant="tonal"
              prepend-icon="mdi-delete-outline"
              :loading="acting"
              data-test="invoice-delete"
              @click="deleteInvoice"
            >
              {{ t("common.delete") }}
            </v-btn>
          </div>
        </template>
      </AppCard>

      <v-card variant="outlined" rounded="lg" class="mb-4">
        <v-card-text>
        <div class="text-subtitle-2 mb-2">{{ t("invoices.lineItems") }}</div>
        <v-table density="compact">
          <thead>
            <tr>
              <th>{{ t("invoices.lineCols.description") }}</th>
              <th class="text-right">{{ t("invoices.lineCols.qty") }}</th>
              <th class="text-right">{{ t("invoices.lineCols.unit") }}</th>
              <th class="text-right">{{ t("invoices.lineCols.total") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(li, i) in invoice.lineItems" :key="i">
              <td>{{ li.description }}</td>
              <td class="text-right">{{ li.quantity }}</td>
              <td class="text-right">{{ minorToDisplay(li.unitPriceMinor, invoice.currency) }}</td>
              <td class="text-right">{{ minorToDisplay(li.lineTotalMinor, invoice.currency) }}</td>
            </tr>
          </tbody>
        </v-table>
        <v-divider class="my-3" />
        <div class="d-flex justify-end">
          <div style="min-width: 240px">
            <div class="d-flex justify-space-between">
              <span>{{ t("invoices.totals.subtotal") }}</span><span>{{ minorToDisplay(invoice.subtotalMinor, invoice.currency) }}</span>
            </div>
            <div class="d-flex justify-space-between">
              <span>{{ t("invoices.totals.tax") }}</span><span>{{ minorToDisplay(invoice.taxMinor, invoice.currency) }}</span>
            </div>
            <div class="d-flex justify-space-between text-subtitle-1 font-weight-medium">
              <span>{{ t("invoices.totals.total") }}</span><span>{{ minorToDisplay(invoice.grandTotalMinor, invoice.currency) }}</span>
            </div>
            <div class="d-flex justify-space-between">
              <span>{{ t("invoices.totals.paid") }}</span><span>{{ minorToDisplay(invoice.amountPaidMinor, invoice.currency) }}</span>
            </div>
            <div class="d-flex justify-space-between font-weight-medium">
              <span>{{ t("invoices.totals.due") }}</span><span>{{ minorToDisplay(invoice.amountDueMinor, invoice.currency) }}</span>
            </div>
          </div>
        </div>
        </v-card-text>
      </v-card>

      <v-card variant="outlined" rounded="lg">
        <v-card-text>
        <div class="text-subtitle-2 mb-2">{{ t("invoices.payments") }}</div>
        <div
          v-if="invoice.payments.length === 0"
          class="text-body-2"
          style="color: var(--v-billy-text-3)"
        >
          {{ t("invoices.noPayments") }}
        </div>
        <v-table v-else density="compact">
          <thead>
            <tr>
              <th>{{ t("invoices.payColumns.date") }}</th>
              <th>{{ t("invoices.payColumns.method") }}</th>
              <th>{{ t("invoices.payColumns.reference") }}</th>
              <th class="text-right">{{ t("invoices.payColumns.amount") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in invoice.payments" :key="p.id">
              <td>{{ p.date }}</td>
              <td>
                {{ enumLabel(t, "paymentMethod", p.method) }}
                <span v-if="p.bankAccountLabel" class="text-medium-emphasis"> · {{ p.bankAccountLabel }}</span>
              </td>
              <td>{{ p.reference ?? "—" }}</td>
              <td class="text-right">{{ minorToDisplay(p.amountMinor, invoice.currency) }}</td>
            </tr>
          </tbody>
        </v-table>
        </v-card-text>
      </v-card>
    </template>

    <SendDocumentModal
      v-if="invoice"
      v-model="sendModal"
      document-type="invoice"
      :document-id="invoice.id"
      :kind="sendKind"
      :version="invoice.version"
      @sent="load"
    />

    <v-dialog v-model="scheduleDialog" max-width="440">
      <v-card>
        <v-card-title>{{ t("invoices.schedule.dialogTitle") }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-4" style="color: var(--v-billy-text-2)">
            {{ t("invoices.schedule.dialogHint") }}
          </p>
          <v-text-field
            v-model="scheduleDate"
            :label="t('invoices.schedule.dateLabel')"
            type="date"
            :min="today"
            density="comfortable"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="scheduleDialog = false">{{ t("invoices.schedule.cancel") }}</v-btn>
          <v-btn color="primary" :loading="acting" @click="submitSchedule">
            {{ t("invoices.schedule.confirm") }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="payDialog" max-width="480">
      <v-card>
        <v-card-title>{{ t("invoices.payDialog.title") }}</v-card-title>
        <v-card-text>
          <v-text-field
            v-model.number="payAmountMajor"
            :label="t('invoices.payDialog.amount')"
            type="number"
            :prefix="invoice?.currency"
            density="comfortable"
          />
          <v-text-field v-model="payDate" :label="t('invoices.payDialog.date')" type="date" density="comfortable" />
          <v-select v-model="paySelection" :items="PAYMENT_METHOD_ITEMS" :label="t('invoices.payDialog.method')" density="comfortable" />
          <v-text-field v-model="payReference" :label="t('invoices.payDialog.reference')" density="comfortable" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="payDialog = false">{{ t("common.cancel") }}</v-btn>
          <v-btn color="primary" :loading="acting" @click="submitPayment">{{ t("invoices.recordPayment") }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
