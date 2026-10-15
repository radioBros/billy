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
import PageHeader from "@/components/PageHeader.vue";
import { useIsMobile } from "@/composables/useIsMobile";
import DocumentActions from "@/components/DocumentActions.vue";
import SendDocumentModal from "@/components/SendDocumentModal.vue";
import EInvoicePanel from "@/components/einvoicing/EInvoicePanel.vue";
import EInvoiceSentChip from "@/components/einvoicing/EInvoiceSentChip.vue";
import EInvoiceActionButton from "@/components/einvoicing/EInvoiceActionButton.vue";
import EInvoiceScheduleOption from "@/components/einvoicing/EInvoiceScheduleOption.vue";
import { isApiCode } from "@/composables/useEInvoice";
import { useToast } from "@/composables/useToast";
import { useEInvoicing } from "@/stores/einvoicing";
import type { SendKind } from "@/composables/useSendDocument";
import { confirm } from "@/composables/useConfirm";
import { useAuthStore } from "@/stores/auth";
import type { EInvoiceInfo } from "@/types/domain";

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const auth = useAuthStore();
const einvoicing = useEInvoicing();
const { toast } = useToast();
const isMobile = useIsMobile();
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

// ── Phone layout helpers ───────────────────────────────────────────────────
// Paid share of the total (0–100) for the hero progress bar; null when either
// amount is stripped (restricted users) or the total is zero.
const paidPercent = computed<number | null>(() => {
  const paid = invoice.value?.amountPaidMinor;
  const total = invoice.value?.grandTotalMinor;
  if (paid == null || total == null || total <= 0) return null;
  return Math.min(100, Math.max(0, (paid / total) * 100));
});
// Payment progress only means something once the invoice is numbered and live.
const showPaymentSummary = computed<boolean>(() => canVoid.value);
// Phone primary row: "Add payment" leads while money is still due; once paid it
// moves to the overflow menu and Send leads instead.
const payIsPrimary = computed<boolean>(() => canVoid.value && invoice.value?.status !== "paid");
const hasOverflow = computed<boolean>(
  () => isDraft.value || isScheduled.value || canSend.value || canVoid.value || canDelete.value,
);

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
// "Send officially via SdI when issued" (e-invoicing only).
const submitOnFinalize = ref(false);

// Once the invoice is legally issued at SdI it can no longer be voided — the fix
// is a credit note. Fed by the e-invoice panel; also learned from a 409.
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
    if (isApiCode(err, "EINVOICE_LEGALLY_ISSUED")) {
      legallyIssued.value = true;
      toast.error(t("einvoicing.errors.legallyIssued"));
    } else {
      actionError.value =
        err instanceof ApiError
          ? t("common.actionFailed", { code: apiErrorReason(err) })
          : t("common.actionFailedGeneric");
    }
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
  submitOnFinalize.value = einvoicing.enabled && einvoicing.scheduledDefaultSubmit;
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
      {
        scheduledSendDate: scheduleDate.value,
        ...(einvoicing.enabled ? { submitOnFinalize: submitOnFinalize.value } : {}),
      },
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
  void einvoicing.load();
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
    <PageHeader :title="t('invoices.detailTitle')" back>
      <!-- Phone: secondary + destructive lifecycle actions live in an overflow menu. -->
      <template v-if="invoice && !loading && hasOverflow" #mobile-actions>
        <v-menu location="bottom end">
          <template #activator="{ props: menuProps }">
            <v-btn v-bind="menuProps" icon="mdi-dots-vertical" variant="text" :aria-label="t('rowActions.menu')" data-test="invoice-more" />
          </template>
          <v-list density="comfortable" min-width="220">
            <v-list-item v-if="isDraft" prepend-icon="mdi-calendar-clock" :title="t('invoices.schedule.action')" @click="openScheduleDialog" />
            <v-list-item v-if="isScheduled" prepend-icon="mdi-calendar-remove" :title="t('invoices.schedule.unscheduleAction')" @click="unschedule" />
            <v-list-item v-if="canVoid && !payIsPrimary" prepend-icon="mdi-cash-plus" :title="t('invoices.addPayment')" @click="payDialog = true" />
            <v-list-item v-if="canSend" prepend-icon="mdi-email-alert-outline" :title="t('invoices.sendReminder')" @click="openSend('reminder')" />
            <v-list-item
              v-if="canVoid"
              prepend-icon="mdi-cancel"
              base-color="error"
              :title="t('invoices.void')"
              :subtitle="legallyIssued ? t('einvoicing.errors.legallyIssued') : undefined"
              :disabled="legallyIssued"
              data-test="invoice-void"
              @click="voidInvoice"
            />
            <v-list-item
              v-if="canDelete"
              prepend-icon="mdi-delete-outline"
              base-color="error"
              :title="t('common.delete')"
              data-test="invoice-delete"
              @click="deleteInvoice"
            />
          </v-list>
        </v-menu>
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

    <template v-else-if="invoice">
      <v-alert v-if="actionError" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
        {{ actionError }}
      </v-alert>

      <!-- ── Phone: hero summary + actions ─────────────────────────────── -->
      <template v-if="isMobile">
        <section class="dd-card dd-hero">
          <div class="dd-hero__head">
            <div class="dd-hero__number">{{ invoice.invoiceNumber ?? t("invoices.draftUnnumbered") }}</div>
            <div class="dd-hero__chips">
              <StatusChip :status="invoice.status" />
              <EInvoiceSentChip v-if="einvoicing.enabled" :info="einvoiceInfo" @click="einvoiceOpen = !einvoiceOpen" />
            </div>
          </div>
          <div class="dd-hero__client">{{ clientNameOf(invoice.clientId) ?? "\u2014" }}</div>

          <v-alert
            v-if="isScheduled && invoice.scheduledSendDate"
            type="warning"
            variant="tonal"
            density="compact"
            class="mt-3"
            icon="mdi-calendar-clock"
          >
            {{ t("invoices.schedule.banner", { date: invoice.scheduledSendDate }) }}
          </v-alert>

          <div class="dd-label mt-4">{{ t("invoices.totals.total") }}</div>
          <div class="dd-hero__total">{{ minorToDisplay(invoice.grandTotalMinor, invoice.currency) }}</div>

          <template v-if="showPaymentSummary">
            <v-progress-linear
              v-if="paidPercent !== null"
              :model-value="paidPercent"
              color="success"
              bg-color="on-surface"
              height="6"
              rounded
              class="mt-3"
            />
            <div class="dd-hero__split">
              <div>
                <div class="dd-label">{{ t("invoices.totals.paid") }}</div>
                <div class="dd-hero__figure">{{ minorToDisplay(invoice.amountPaidMinor, invoice.currency) }}</div>
              </div>
              <div class="text-right">
                <div class="dd-label">{{ t("invoices.totals.due") }}</div>
                <div class="dd-hero__figure" :class="(invoice.amountDueMinor ?? 0) > 0 ? 'text-warning' : 'text-success'">
                  {{ minorToDisplay(invoice.amountDueMinor, invoice.currency) }}
                </div>
              </div>
            </div>
          </template>

          <div class="dd-hero__meta">
            <div>
              <div class="dd-label">{{ t("invoices.detail.issueDate") }}</div>
              <div class="dd-value">{{ invoice.issueDate }}</div>
            </div>
            <div>
              <div class="dd-label">{{ t("invoices.detail.dueDate") }}</div>
              <div class="dd-value">{{ invoice.dueDate }}</div>
            </div>
          </div>
        </section>

        <div class="dd-actions">
          <div class="dd-actions__primary">
            <v-btn v-if="canFinalize" color="primary" variant="flat" size="large" :loading="acting" @click="finalize">
              {{ t("invoices.finalize") }}
            </v-btn>
            <v-btn
              v-if="isDraft"
              color="primary"
              variant="tonal"
              size="large"
              prepend-icon="mdi-pencil"
              :to="{ name: 'invoice-edit', params: { id: invoice.id } }"
            >
              {{ t("common.edit") }}
            </v-btn>
            <v-btn v-if="payIsPrimary" color="primary" variant="flat" size="large" prepend-icon="mdi-cash-plus" :loading="acting" @click="payDialog = true">
              {{ t("invoices.addPayment") }}
            </v-btn>
            <v-btn
              v-if="canSend"
              color="primary"
              :variant="payIsPrimary ? 'tonal' : 'flat'"
              size="large"
              prepend-icon="mdi-email-outline"
              :loading="acting"
              @click="openSend('invoice')"
            >
              {{ t("invoices.send") }}
            </v-btn>
          </div>
          <DocumentActions document-type="invoice" :document-id="invoice.id" />
          <EInvoiceActionButton
            v-if="einvoicing.enabled && canSend"
            :info="einvoiceInfo"
            :open="einvoiceOpen"
            class="dd-actions__wide"
            @toggle="einvoiceOpen = !einvoiceOpen"
          />
        </div>
      </template>

      <AppCard v-else>
        <template #header>
          <div class="text-h6 mr-3">{{ invoice.invoiceNumber ?? t("invoices.draftUnnumbered") }}</div>
          <StatusChip :status="invoice.status" />
          <EInvoiceSentChip v-if="einvoicing.enabled" :info="einvoiceInfo" @click="einvoiceOpen = !einvoiceOpen" />
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
            <v-btn
              v-if="canVoid"
              color="error"
              :loading="acting"
              :disabled="legallyIssued"
              :title="legallyIssued ? t('einvoicing.errors.legallyIssued') : undefined"
              data-test="invoice-void"
              @click="voidInvoice"
            >
              {{ t("invoices.void") }}
            </v-btn>
            <v-btn v-if="canVoid" color="primary" :loading="acting" @click="payDialog = true">
              {{ t("invoices.addPayment") }}
            </v-btn>
            <EInvoiceActionButton
              v-if="einvoicing.enabled && canSend"
              :info="einvoiceInfo"
              :open="einvoiceOpen"
              @toggle="einvoiceOpen = !einvoiceOpen"
            />
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

      <v-expand-transition>
        <div v-show="isScheduled || einvoiceOpen" data-test="einvoice-collapse">
        <EInvoicePanel
          v-if="einvoicing.enabled && (canSend || isScheduled)"
          kind="invoices"
          :document-id="invoice.id"
          :client-id="invoice.clientId"
          :scheduled="isScheduled"
          :refresh-key="invoice.version"
          @loaded="onEInvoiceLoaded"
        />
        </div>
      </v-expand-transition>

      <!-- ── Phone: line cards + totals, payment cards ─────────────────── -->
      <template v-if="isMobile">
        <section class="dd-card">
          <div class="dd-section-title">{{ t("invoices.lineItems") }}</div>
          <div v-for="(li, i) in invoice.lineItems" :key="i" class="dd-line">
            <div class="dd-line__desc">{{ li.description }}</div>
            <div class="dd-line__row">
              <span class="dd-line__calc">
                {{ li.quantity }} × {{ minorToDisplay(li.unitPriceMinor, invoice.currency) }}
                <template v-if="li.discountRate"> · −{{ li.discountRate }}%</template>
                <template v-if="li.taxRate != null"> · {{ t("invoices.totals.tax") }} {{ li.taxRate }}%</template>
              </span>
              <span class="dd-line__total">{{ minorToDisplay(li.lineTotalMinor, invoice.currency) }}</span>
            </div>
          </div>
          <div class="dd-totals">
            <div class="dd-totals__row">
              <span>{{ t("invoices.totals.subtotal") }}</span><span>{{ minorToDisplay(invoice.subtotalMinor, invoice.currency) }}</span>
            </div>
            <div class="dd-totals__row">
              <span>{{ t("invoices.totals.tax") }}</span><span>{{ minorToDisplay(invoice.taxMinor, invoice.currency) }}</span>
            </div>
            <div class="dd-totals__row dd-totals__row--grand">
              <span>{{ t("invoices.totals.total") }}</span><span>{{ minorToDisplay(invoice.grandTotalMinor, invoice.currency) }}</span>
            </div>
            <div class="dd-totals__row">
              <span>{{ t("invoices.totals.paid") }}</span><span>{{ minorToDisplay(invoice.amountPaidMinor, invoice.currency) }}</span>
            </div>
            <div class="dd-totals__row dd-totals__row--strong">
              <span>{{ t("invoices.totals.due") }}</span><span>{{ minorToDisplay(invoice.amountDueMinor, invoice.currency) }}</span>
            </div>
          </div>
        </section>

        <section class="dd-card">
          <div class="dd-section-title">{{ t("invoices.payments") }}</div>
          <div v-if="invoice.payments.length === 0" class="dd-empty">{{ t("invoices.noPayments") }}</div>
          <div v-for="p in invoice.payments" :key="p.id" class="dd-pay">
            <v-avatar size="36" color="success" variant="tonal" class="dd-pay__icon">
              <v-icon icon="mdi-cash-check" size="20" />
            </v-avatar>
            <div class="dd-pay__main">
              <div class="dd-pay__method">
                {{ enumLabel(t, "paymentMethod", p.method) }}<template v-if="p.bankAccountLabel"> · {{ p.bankAccountLabel }}</template>
              </div>
              <div class="dd-pay__sub">
                {{ p.date }}<template v-if="p.reference"> · {{ p.reference }}</template>
              </div>
            </div>
            <div class="dd-pay__amount">{{ minorToDisplay(p.amountMinor, invoice.currency) }}</div>
          </div>
        </section>
      </template>

      <template v-else>
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
          <EInvoiceScheduleOption
            v-if="invoice"
            v-model="submitOnFinalize"
            :document-id="invoice.id"
            :client-id="invoice.clientId"
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
