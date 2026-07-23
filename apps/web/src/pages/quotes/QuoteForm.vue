<script setup lang="ts">
/**
 * Quote create/edit form. Mirrors InvoiceForm. Validation mirrors quotes/schema.ts:
 * clientId, currency (ISO-4217), issueDate, expiryDate (≥ issueDate), ≥1 line item.
 * Totals are server-computed — the LineItemEditor emits raw line inputs only.
 * PATCH sends the optimistic-concurrency version via the If-Match header.
 */
import { ref, computed, onMounted, watch } from "vue";
import { addDays, todayIso } from "@/utils/dates";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import type { Quote, LineItemInput } from "@/types/domain";
import LineItemEditor from "@/components/LineItemEditor.vue";
import ClientSelector from "@/components/ClientSelector.vue";
import ClientLanguageHint from "@/components/ClientLanguageHint.vue";
import ProjectSelect from "@/components/ProjectSelect.vue";
import AppCard from "@/components/AppCard.vue";
import DocumentPreviewDialog from "@/components/DocumentPreviewDialog.vue";
import { consumeClone } from "@/composables/useClonePrefill";
import { useFormSubmit, type VuetifyFormRef } from "@/composables/useFormSubmit";
import { useToast } from "@/composables/useToast";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const id = computed<string | null>(() => (route.params.id as string | undefined) ?? null);
const isEdit = computed<boolean>(() => id.value !== null);

const clientId = ref<string | null>("");
const projectId = ref<string | null>(null);
const currency = ref("EUR");
const issueDate = ref(todayIso());
// Expiry defaults to 7 days after issue and auto-tracks issueDate until edited.
const expiryDate = ref(addDays(issueDate.value, 7));
const expiryTouched = ref(false);
watch(issueDate, (next) => {
  if (!expiryTouched.value) expiryDate.value = addDays(next, 7);
});
watch(expiryDate, (next) => {
  if (next !== addDays(issueDate.value, 7)) expiryTouched.value = true;
});
const subject = ref("");
const clientLocale = ref<string | null>(null);
const notes = ref("");
const lineItems = ref<LineItemInput[]>([{ description: "", quantity: 1, unitPriceMinor: 0 }]);
const version = ref<number | null>(null);
const status = ref<string | null>(null);

const loading = ref(false);
const errorMessage = ref<string | null>(null);
const fieldErrors = ref<Record<string, string>>({});

const formRef = ref<VuetifyFormRef | null>(null);
const { submit, submitting } = useFormSubmit(formRef);
const { toast } = useToast();

// ── Live preview of the current (unsaved) draft.
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
      expiryDate: expiryDate.value,
      subject: subject.value.trim() || null,
      notes: notes.value.trim() || null,
      lineItems: lineItems.value,
    };
    const { html } = await api.post<{ html: string }>("/v1/quotes/preview-draft", payload);
    previewHtml.value = html;
  } catch {
    toast.error(t("documents.previewError"));
    previewOpen.value = false;
  } finally {
    previewLoading.value = false;
  }
};

const required = (v: unknown): boolean | string =>
  (!!v && String(v).trim().length > 0) || t("common.required");
const currencyRule = (v: string): boolean | string =>
  /^[A-Z]{3}$/u.test(v) || t("common.currencyRule");
const expiryRule = (v: string): boolean | string =>
  !issueDate.value || !v || v >= issueDate.value || t("quotes.expiryRule");

const nonDraft = computed<boolean>(() => isEdit.value && status.value !== null && status.value !== "draft");

const loadQuote = async (): Promise<void> => {
  if (!id.value) return;
  loading.value = true;
  errorMessage.value = null;
  try {
    const q = await api.get<Quote>(`/v1/quotes/${id.value}`);
    clientId.value = q.clientId;
    projectId.value = q.projectId ?? null;
    currency.value = q.currency;
    issueDate.value = q.issueDate;
    expiryDate.value = q.expiryDate;
    expiryTouched.value = true; // editing: keep the stored expiry
    subject.value = q.subject ?? "";
    notes.value = q.notes ?? "";
    lineItems.value = q.lineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unitPriceMinor: li.unitPriceMinor,
      discountRate: li.discountRate,
      taxRate: li.taxRate,
    }));
    version.value = q.version;
    status.value = q.status;
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError
        ? t("quotes.loadOneError", { code: err.code })
        : t("quotes.loadOneErrorGeneric");
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
    expiryDate: expiryDate.value,
    lineItems: lineItems.value,
    subject: subject.value.trim() || null,
    notes: notes.value.trim() || null,
  };
  try {
    if (isEdit.value && id.value) {
      const updated = await api.patch<Quote>(`/v1/quotes/${id.value}`, payload, {
        ifMatch: version.value ?? undefined,
      });
      toast.success(t("quotes.saved"));
      await router.push({ name: "quote-detail", params: { id: updated.id } });
    } else {
      const created = await api.post<Quote>("/v1/quotes", payload);
      toast.success(t("quotes.saved"));
      await router.push({ name: "quote-detail", params: { id: created.id } });
    }
  } catch (err) {
    if (err instanceof ApiError) {
      applyValidationDetails(err);
      errorMessage.value = t("quotes.saveError", { code: err.code });
    } else {
      errorMessage.value = t("quotes.saveErrorGeneric");
    }
    toast.error(errorMessage.value);
  }
};

const applyClone = (): void => {
  if (isEdit.value) return;
  const seed = consumeClone("quote");
  if (!seed) return;
  if (typeof seed.clientId === "string") clientId.value = seed.clientId;
  if (typeof seed.currency === "string") currency.value = seed.currency;
  if (typeof seed.issueDate === "string") issueDate.value = seed.issueDate;
  if (typeof seed.expiryDate === "string") expiryDate.value = seed.expiryDate;
  if (typeof seed.subject === "string") subject.value = seed.subject;
  if (typeof seed.notes === "string") notes.value = seed.notes;
  if (Array.isArray(seed.lineItems) && seed.lineItems.length > 0) {
    lineItems.value = seed.lineItems as LineItemInput[];
  }
};

onMounted(() => {
  void loadQuote();
  applyClone();
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 12px">
      <v-btn icon="mdi-arrow-left" variant="text" :aria-label="t('common.back')" @click="router.back()" />
      <h1 class="text-h5">{{ isEdit ? t("quotes.editTitle") : t("quotes.newTitle") }}</h1>
    </div>

    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
    </v-alert>

    <v-alert v-if="nonDraft" type="warning" variant="tonal" density="compact" class="mb-4">
      {{ t("quotes.locked") }}
    </v-alert>

    <v-card v-if="loading" variant="outlined" rounded="lg" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </v-card>

    <v-form v-else ref="formRef" @submit.prevent="submit(save)">
      <AppCard>
        <v-row>
          <v-col cols="12" md="6">
            <ClientSelector
              v-model="clientId"
              :label="t('quotes.fields.clientId')"
              :rules="[required]"
              :error-messages="fieldErrors.clientId"
              :disabled="nonDraft"
              @client-locale="clientLocale = $event"
            />
          </v-col>
          <v-col cols="12" md="6">
            <ProjectSelect v-model="projectId" :error-messages="fieldErrors.projectId" />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="currency"
              :label="t('quotes.fields.currency')"
              :rules="[required, currencyRule]"
              :error-messages="fieldErrors.currency"
              :disabled="nonDraft"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="issueDate"
              :label="t('quotes.fields.issueDate')"
              type="date"
              :rules="[required]"
              :error-messages="fieldErrors.issueDate"
              :disabled="nonDraft"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="expiryDate"
              :label="t('quotes.fields.expiryDate')"
              type="date"
              :rules="[required, expiryRule]"
              :error-messages="fieldErrors.expiryDate"
              :disabled="nonDraft"
              density="comfortable"
            />
          </v-col>
        </v-row>
      </AppCard>

      <AppCard :title="t('quotes.lineItems')">
        <ClientLanguageHint :locale="clientLocale" />
        <v-text-field
          v-model="subject"
          :label="t('documents.subject')"
          :disabled="nonDraft"
          density="comfortable"
          class="mb-4"
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
      </AppCard>

      <AppCard :title="t('quotes.fields.notes')">
        <ClientLanguageHint :locale="clientLocale" />
        <v-textarea
          v-model="notes"
          :label="t('quotes.fields.notes')"
          rows="2"
          auto-grow
          :disabled="nonDraft"
          density="comfortable"
        />
        <template #actions>
          <v-btn variant="text" @click="router.back()">{{ t("common.cancel") }}</v-btn>
          <v-spacer />
          <v-btn variant="tonal" color="info" prepend-icon="mdi-eye-outline" type="button" @click="preview">
            {{ t("documents.preview") }}
          </v-btn>
          <v-btn color="primary" type="submit" :loading="submitting" :disabled="nonDraft">
            {{ isEdit ? t("common.saveChanges") : t("quotes.create") }}
          </v-btn>
        </template>
      </AppCard>
    </v-form>

    <DocumentPreviewDialog v-model="previewOpen" :html="previewHtml" :loading="previewLoading" />
  </div>
</template>
