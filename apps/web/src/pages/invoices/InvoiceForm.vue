<script setup lang="ts">
/**
 * Invoice create/edit form. One component serves both routes: with an `:id`
 * route param it loads + PATCHes (draft only); without, it POSTs a new draft.
 * Validation mirrors the backend Zod shape (invoices/schema.ts): clientId,
 * currency (ISO-4217), issueDate, dueDate (≥ issueDate), ≥1 line item.
 *
 * Money is never sent as a total — the LineItemEditor emits raw line inputs and
 * the server recomputes. On PATCH we include the optimistic-concurrency `version`
 * in the body (the API accepts it via body or If-Match).
 */
import { ref, computed, onMounted, watch } from "vue";
import { addDays, todayIso } from "@/utils/dates";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import type { Invoice, LineItemInput, RecurrenceConfig, BankAccount, BusinessSettings } from "@/types/domain";
import LineItemEditor from "@/components/LineItemEditor.vue";
import ClientSelector from "@/components/ClientSelector.vue";
import ClientLanguageHint from "@/components/ClientLanguageHint.vue";
import ProjectSelect from "@/components/ProjectSelect.vue";
import RecurringToggle from "@/components/RecurringToggle.vue";
import SendDocumentModal from "@/components/SendDocumentModal.vue";
import FormActions from "@/components/FormActions.vue";
import DocumentPreviewDialog from "@/components/DocumentPreviewDialog.vue";
import { useRecurringProfile } from "@/composables/useRecurringProfile";
import { consumeClone } from "@/composables/useClonePrefill";
import { useFormSubmit, type VuetifyFormRef } from "@/composables/useFormSubmit";
import { useToast } from "@/composables/useToast";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const id = computed<string | null>(() => (route.params.id as string | undefined) ?? null);
const isEdit = computed<boolean>(() => id.value !== null);

// Recurring is a property of a NEW invoice, set via RecurringToggle (create only).
const recurrence = ref<RecurrenceConfig | null>(null);
const { snackbar, snackbarText, createProfile } = useRecurringProfile();

const clientId = ref<string | null>("");
const projectId = ref<string | null>(null);
const currency = ref("EUR");
const issueDate = ref(todayIso());
// Due date defaults to 7 days after the issue date and auto-tracks issueDate
// until the user edits it manually (then it stays put).
const dueDate = ref(addDays(issueDate.value, 7));
const dueDateTouched = ref(false);
watch(issueDate, (next) => {
  if (!dueDateTouched.value) dueDate.value = addDays(next, 7);
});
watch(dueDate, (next) => {
  // A change that isn't the auto-computed issue+7 means the user set it.
  if (next !== addDays(issueDate.value, 7)) dueDateTouched.value = true;
});
const subject = ref("");
// The selected client's preferred language (from ClientSelector) — surfaced as a
// hint so the user knows which language to write subject/notes in.
const clientLocale = ref<string | null>(null);
const notes = ref("");
const lineItems = ref<LineItemInput[]>([
  { description: "", quantity: 1, unitPriceMinor: 0 },
]);
const version = ref<number | null>(null);
const status = ref<string | null>(null);

// ── Multi-bank picker (create only). Loaded from business settings; shown as a
// select only when >1 account. Exactly 1 → auto-selected; 0 → hidden (backend
// default). The chosen id is sent as `bankAccountId` on the create payload.
const bankAccounts = ref<BankAccount[]>([]);
const bankAccountId = ref<string | null>(null);
const bankItems = computed(() =>
  bankAccounts.value.map((b: BankAccount) => ({ title: b.label, value: b.id })),
);
const showBankPicker = computed<boolean>(() => !isEdit.value && bankAccounts.value.length > 1);

const loading = ref(false);
const errorMessage = ref<string | null>(null);
const fieldErrors = ref<Record<string, string>>({});

const formRef = ref<VuetifyFormRef | null>(null);
const { submit, submitting } = useFormSubmit(formRef);
const { toast } = useToast();

// ── Live preview of the current (unsaved) draft. POSTs the same payload as
// save() to the render-only endpoint and shows the returned HTML in an iframe.
const previewOpen = ref(false);
const previewHtml = ref<string | null>(null);
const previewLoading = ref(false);

const preview = async (): Promise<void> => {
  previewOpen.value = true;
  previewLoading.value = true;
  previewHtml.value = null;
  try {
    const payload = {
      clientId: clientId.value,
      currency: currency.value,
      issueDate: issueDate.value,
      dueDate: dueDate.value,
      subject: subject.value.trim() || null,
      notes: notes.value.trim() || null,
      lineItems: lineItems.value,
    };
    const { html } = await api.post<{ html: string }>("/v1/invoices/preview-draft", payload);
    previewHtml.value = html;
  } catch {
    toast.error(t("documents.previewError"));
    previewOpen.value = false;
  } finally {
    previewLoading.value = false;
  }
};

// ── Create-completion flow (create mode only). After saving a DRAFT invoice we
// don't navigate straight away — we offer the next step: finalize & send,
// schedule (a DRAFT-stage concept), or keep as draft. State for that choice:
const createdInvoice = ref<Invoice | null>(null);
const completionDialog = ref(false);
const completionBusy = ref(false);
const completionError = ref<string | null>(null);
const sendModal = ref(false);
const scheduleDialog = ref(false);
const today = new Date().toISOString().slice(0, 10);
const scheduleDate = ref(today);

const required = (v: unknown): boolean | string =>
  (!!v && String(v).trim().length > 0) || t("common.required");
const currencyRule = (v: string): boolean | string =>
  /^[A-Z]{3}$/u.test(v) || t("common.currencyRule");
const dueRule = (v: string): boolean | string =>
  !issueDate.value || !v || v >= issueDate.value || t("invoices.dueRule");

const nonDraft = computed<boolean>(() => isEdit.value && status.value !== null && status.value !== "draft");

const loadInvoice = async (): Promise<void> => {
  if (!id.value) return;
  loading.value = true;
  errorMessage.value = null;
  try {
    const inv = await api.get<Invoice>(`/v1/invoices/${id.value}`);
    clientId.value = inv.clientId;
    projectId.value = inv.projectId ?? null;
    currency.value = inv.currency;
    issueDate.value = inv.issueDate;
    dueDate.value = inv.dueDate;
    dueDateTouched.value = true; // editing an existing invoice: never auto-shift its due date
    subject.value = inv.subject ?? "";
    notes.value = inv.notes ?? "";
    lineItems.value = inv.lineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unitPriceMinor: li.unitPriceMinor,
      discountRate: li.discountRate,
      taxRate: li.taxRate,
    }));
    version.value = inv.version;
    status.value = inv.status;
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError
        ? t("invoices.loadOneError", { code: err.code })
        : t("invoices.loadOneErrorGeneric");
  } finally {
    loading.value = false;
  }
};

const applyValidationDetails = (err: ApiError): void => {
  fieldErrors.value = {};
  if (err.details && typeof err.details === "object") {
    for (const [k, v] of Object.entries(err.details)) {
      if (typeof v === "string") fieldErrors.value[k] = v;
    }
  }
};

const save = async (): Promise<void> => {
  errorMessage.value = null;
  fieldErrors.value = {};
  const payload: Record<string, unknown> = {
    clientId: clientId.value,
    projectId: projectId.value || null,
    currency: currency.value,
    issueDate: issueDate.value,
    dueDate: dueDate.value,
    lineItems: lineItems.value,
    subject: subject.value.trim() || null,
    notes: notes.value.trim() || null,
  };
  try {
    if (isEdit.value && id.value) {
      const updated = await api.patch<Invoice>(`/v1/invoices/${id.value}`, payload, {
        ifMatch: version.value ?? undefined,
      });
      toast.success(t("invoices.saved"));
      await router.push({ name: "invoice-detail", params: { id: updated.id } });
    } else if (recurrence.value) {
      // Recurring ON: create ONLY the recurring profile (no one-off invoice) —
      // the worker generates every occurrence on schedule, so there is no
      // duplicate "first" invoice. Stay on the form; the snackbar links to the list.
      const profileError = await createProfile({
        documentType: "invoice",
        clientId: clientId.value ?? "",
        currency: currency.value,
        lineItems: lineItems.value,
        recurrence: recurrence.value,
        subject: subject.value.trim() || null,
        notes: notes.value.trim() || null,
      });
      if (profileError) errorMessage.value = profileError;
    } else {
      // Attach the chosen bank account (create only); backend snapshots it.
      if (bankAccountId.value) payload.bankAccountId = bankAccountId.value;
      const created = await api.post<Invoice>("/v1/invoices", payload);
      // Don't navigate silently — present the next-step choice (finalize & send /
      // schedule / keep as draft). The dialog owns navigation from here.
      createdInvoice.value = created;
      completionError.value = null;
      completionDialog.value = true;
    }
  } catch (err) {
    if (err instanceof ApiError) {
      applyValidationDetails(err);
      errorMessage.value = t("invoices.saveError", { code: err.code });
    } else {
      errorMessage.value = t("invoices.saveErrorGeneric");
    }
    toast.error(errorMessage.value);
  }
};

const onSendModalToggle = (value: boolean): void => {
  sendModal.value = value;
  if (!value) void goToCreated();
};

const goToCreated = async (): Promise<void> => {
  if (!createdInvoice.value) return;
  completionDialog.value = false;
  await router.push({ name: "invoice-detail", params: { id: createdInvoice.value.id } });
};

const finalizeAndSend = async (): Promise<void> => {
  if (!createdInvoice.value) return;
  completionBusy.value = true;
  completionError.value = null;
  try {
    createdInvoice.value = await api.post<Invoice>(
      `/v1/invoices/${createdInvoice.value.id}/finalize`,
      undefined,
      { ifMatch: createdInvoice.value.version },
    );
    completionDialog.value = false;
    sendModal.value = true;
  } catch (err) {
    completionError.value =
      err instanceof ApiError
        ? t("common.actionFailed", { code: err.code })
        : t("common.actionFailedGeneric");
  } finally {
    completionBusy.value = false;
  }
};

const submitSchedule = async (): Promise<void> => {
  if (!createdInvoice.value) return;
  if (!scheduleDate.value || scheduleDate.value < today) {
    completionError.value = t("invoices.schedule.dateError");
    return;
  }
  completionBusy.value = true;
  completionError.value = null;
  try {
    await api.post<Invoice>(
      `/v1/invoices/${createdInvoice.value.id}/schedule`,
      { scheduledSendDate: scheduleDate.value },
      { ifMatch: createdInvoice.value.version },
    );
    scheduleDialog.value = false;
    await goToCreated();
  } catch (err) {
    completionError.value =
      err instanceof ApiError
        ? t("common.actionFailed", { code: err.code })
        : t("common.actionFailedGeneric");
  } finally {
    completionBusy.value = false;
  }
};

const applyClone = (): void => {
  if (isEdit.value) return;
  const seed = consumeClone("invoice");
  if (!seed) return;
  if (typeof seed.clientId === "string") clientId.value = seed.clientId;
  if (typeof seed.currency === "string") currency.value = seed.currency;
  if (typeof seed.issueDate === "string") issueDate.value = seed.issueDate;
  if (typeof seed.dueDate === "string") dueDate.value = seed.dueDate;
  if (typeof seed.subject === "string") subject.value = seed.subject;
  if (typeof seed.notes === "string") notes.value = seed.notes;
  if (Array.isArray(seed.lineItems) && seed.lineItems.length > 0) {
    lineItems.value = seed.lineItems as LineItemInput[];
  }
};

const loadBankAccounts = async (): Promise<void> => {
  if (isEdit.value) return;
  try {
    const biz = await api.get<BusinessSettings>("/v1/settings/business");
    bankAccounts.value = biz.bankAccounts ?? [];
    if (bankAccounts.value.length === 1) bankAccountId.value = bankAccounts.value[0]!.id;
  } catch {
    // Non-fatal: no picker, backend applies its default.
  }
};

onMounted(() => {
  void loadInvoice();
  applyClone();
  void loadBankAccounts();
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 12px">
      <v-btn icon="mdi-arrow-left" variant="text" :aria-label="t('common.back')" @click="router.back()" />
      <h1 class="text-h5">{{ isEdit ? t("invoices.editTitle") : t("invoices.newTitle") }}</h1>
    </div>

    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
    </v-alert>

    <v-alert v-if="nonDraft" type="warning" variant="tonal" density="compact" class="mb-4">
      {{ t("invoices.locked") }}
    </v-alert>

    <v-card v-if="loading" variant="outlined" rounded="lg" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </v-card>

    <v-form v-else ref="formRef" @submit.prevent="submit(save)">
      <v-card variant="outlined" rounded="lg" class="mb-4">
        <v-card-text>
        <v-row>
          <v-col cols="12" md="6">
            <ClientSelector
              v-model="clientId"
              :label="t('invoices.fields.client')"
              :rules="[required]"
              :error-messages="fieldErrors.clientId"
              :disabled="nonDraft"
              @client-locale="clientLocale = $event"
            />
          </v-col>
          <v-col cols="12" md="6">
            <ProjectSelect
              v-model="projectId"
              :error-messages="fieldErrors.projectId"
              :disabled="nonDraft"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="currency"
              :label="t('invoices.fields.currency')"
              :rules="[required, currencyRule]"
              :error-messages="fieldErrors.currency"
              :disabled="nonDraft"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="issueDate"
              :label="t('invoices.fields.issueDate')"
              type="date"
              :rules="[required]"
              :error-messages="fieldErrors.issueDate"
              :disabled="nonDraft"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="dueDate"
              :label="t('invoices.fields.dueDate')"
              type="date"
              :rules="[required, dueRule]"
              :error-messages="fieldErrors.dueDate"
              :disabled="nonDraft"
              density="comfortable"
            />
          </v-col>
          <v-col v-if="showBankPicker" cols="12" md="6">
            <v-select
              v-model="bankAccountId"
              :items="bankItems"
              :label="t('invoices.fields.bankAccount')"
              :hint="t('invoices.bankAccountHint')"
              persistent-hint
              density="comfortable"
            />
          </v-col>
        </v-row>
        </v-card-text>
      </v-card>

      <v-card variant="outlined" rounded="lg" class="mb-4">
        <v-card-text>
        <ClientLanguageHint :locale="clientLocale" />
        <v-text-field
          v-model="subject"
          :label="t('documents.subject')"
          density="comfortable"
          class="mb-4"
          :disabled="nonDraft"
        />
        <LineItemEditor v-model="lineItems" :currency="currency" :disabled="nonDraft" />
        <v-alert
          v-if="fieldErrors.lineItems"
          type="error"
          variant="tonal"
          density="compact"
          class="mt-2"
        >
          {{ fieldErrors.lineItems }}
        </v-alert>
        </v-card-text>
      </v-card>

      <v-card variant="outlined" rounded="lg" class="mb-4">
        <v-card-text>
        <ClientLanguageHint :locale="clientLocale" />
        <v-textarea
          v-model="notes"
          :label="t('invoices.fields.notes')"
          rows="2"
          auto-grow
          :disabled="nonDraft"
          density="comfortable"
        />
        </v-card-text>
      </v-card>

      <RecurringToggle v-if="!isEdit" v-model="recurrence" :disabled="submitting" />

      <FormActions>
        <template #cancel>
          <v-btn variant="text" @click="router.back()">{{ t("common.cancel") }}</v-btn>
        </template>
        <v-btn
          variant="tonal"
          color="info"
          prepend-icon="mdi-eye-outline"
          type="button"
          @click="preview"
        >
          {{ t("documents.preview") }}
        </v-btn>
        <v-btn
          color="primary"
          type="submit"
          :loading="submitting"
          :disabled="nonDraft"
        >
          {{ isEdit ? t("common.saveChanges") : t("invoices.create") }}
        </v-btn>
      </FormActions>
    </v-form>

    <DocumentPreviewDialog v-model="previewOpen" :html="previewHtml" :loading="previewLoading" />

    <v-snackbar v-model="snackbar" color="success" :timeout="6000">
      {{ snackbarText }}
      <template #actions>
        <v-btn variant="text" :to="{ name: 'recurring-profiles' }">{{ t("recurring.toggle.viewList") }}</v-btn>
      </template>
    </v-snackbar>

    <!-- Create-completion choice: finalize & send / schedule / keep as draft. -->
    <v-dialog v-model="completionDialog" max-width="480" persistent>
      <v-card variant="outlined" rounded="lg">
        <v-card-title>{{ t("invoices.completion.title") }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-4" style="color: var(--v-billy-text-2)">
            {{ t("invoices.completion.hint") }}
          </p>
          <v-alert
            v-if="completionError"
            type="error"
            variant="tonal"
            density="compact"
            class="mb-4"
            role="alert"
          >
            {{ completionError }}
          </v-alert>
          <div class="d-flex flex-column" style="gap: 12px">
            <v-btn
              color="primary"
              prepend-icon="mdi-email-outline"
              block
              :loading="completionBusy"
              data-test="completion-finalize-send"
              @click="finalizeAndSend"
            >
              {{ t("invoices.completion.finalizeAndSend") }}
            </v-btn>
            <v-btn
              variant="outlined"
              prepend-icon="mdi-calendar-clock"
              block
              :disabled="completionBusy"
              data-test="completion-schedule"
              @click="scheduleDate = today; scheduleDialog = true"
            >
              {{ t("invoices.completion.schedule") }}
            </v-btn>
            <v-btn
              variant="text"
              block
              :disabled="completionBusy"
              data-test="completion-keep-draft"
              @click="goToCreated"
            >
              {{ t("invoices.completion.keepDraft") }}
            </v-btn>
          </div>
        </v-card-text>
      </v-card>
    </v-dialog>

    <!-- Schedule (draft → scheduled) — reached from the completion choice. -->
    <v-dialog v-model="scheduleDialog" max-width="440">
      <v-card variant="outlined" rounded="lg">
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
          <v-btn color="primary" :loading="completionBusy" @click="submitSchedule">
            {{ t("invoices.schedule.confirm") }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <SendDocumentModal
      v-if="createdInvoice"
      v-model="sendModal"
      document-type="invoice"
      :document-id="createdInvoice.id"
      kind="invoice"
      :version="createdInvoice.version"
      @update:model-value="onSendModalToggle"
    />
  </div>
</template>
