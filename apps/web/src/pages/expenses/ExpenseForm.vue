<script setup lang="ts">
/**
 * Expense create/edit form. One component serves both routes: with an `:id`
 * route param it loads + PATCHes; without, it POSTs a new expense. Validation
 * mirrors the backend Zod shape: amount (positive), currency (ISO-4217),
 * category, date, vendor required.
 *
 * Money is entered in MAJOR units (e.g. 10.50) via a local ref and converted to
 * integer minor units with majorToMinor() when building the payload. On PATCH we
 * send the optimistic-concurrency `version` in the BODY (the expenses route reads
 * it from the required schema field, not If-Match).
 */
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import type { Expense, RecurrenceConfig } from "@/types/domain";
import { majorToMinor, minorToMajor } from "@/utils/money";
import RecurringToggle from "@/components/RecurringToggle.vue";
import ClientSelector from "@/components/ClientSelector.vue";
import ProjectSelect from "@/components/ProjectSelect.vue";
import AppCard from "@/components/AppCard.vue";
import { useRecurringProfile } from "@/composables/useRecurringProfile";
import { consumeClone } from "@/composables/useClonePrefill";
import { useFormSubmit, type VuetifyFormRef } from "@/composables/useFormSubmit";
import { useToast } from "@/composables/useToast";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const id = computed<string | null>(() => (route.params.id as string | undefined) ?? null);
const isEdit = computed<boolean>(() => id.value !== null);

// Recurring is a property of a NEW expense, set via RecurringToggle (create only).
const recurrence = ref<RecurrenceConfig | null>(null);
const { snackbar, snackbarText, createProfile } = useRecurringProfile();

const amountMajor = ref<number | null>(null);
const currency = ref("EUR");
const category = ref("");
const date = ref(new Date().toISOString().slice(0, 10));
const vendor = ref("");
const description = ref("");
const clientId = ref<string | null>("");
const projectId = ref<string | null>(null);
const billable = ref(false);
const version = ref<number | null>(null);

const loading = ref(false);
const errorMessage = ref<string | null>(null);
const fieldErrors = ref<Record<string, string>>({});

const formRef = ref<VuetifyFormRef | null>(null);
const { submit, submitting } = useFormSubmit(formRef);
const { toast } = useToast();

const required = (v: unknown): boolean | string =>
  (!!v && String(v).trim().length > 0) || t("common.required");
const currencyRule = (v: string): boolean | string =>
  /^[A-Z]{3}$/u.test(v) || t("common.currencyRule");
const amountRule = (v: number | null): boolean | string =>
  (v !== null && Number.isFinite(v) && v > 0) || t("expenses.amountRule");

const loadExpense = async (): Promise<void> => {
  if (!id.value) return;
  loading.value = true;
  errorMessage.value = null;
  try {
    const exp = await api.get<Expense>(`/v1/expenses/${id.value}`);
    amountMajor.value = minorToMajor(exp.amountMinor);
    currency.value = exp.currency;
    category.value = exp.category;
    date.value = exp.date;
    vendor.value = exp.vendor;
    description.value = exp.description;
    clientId.value = exp.clientId ?? "";
    projectId.value = exp.projectId ?? null;
    billable.value = exp.billable;
    version.value = exp.version;
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError
        ? t("expenses.loadOneError", { code: err.code })
        : t("expenses.loadOneErrorGeneric");
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
    amountMinor: majorToMinor(amountMajor.value),
    currency: currency.value,
    category: category.value,
    date: date.value,
    vendor: vendor.value,
    description: description.value,
    billable: billable.value,
  };
  const trimmedClientId = clientId.value?.trim() ?? "";
  if (trimmedClientId) payload.clientId = trimmedClientId;
  payload.projectId = projectId.value || null;
  try {
    if (isEdit.value && id.value) {
      // Expenses PATCH reads `version` from the (required) request BODY — not
      // If-Match — so it must be in the payload (ExpenseUpdateSchema requires it).
      payload.version = version.value ?? undefined;
      await api.patch<Expense>(`/v1/expenses/${id.value}`, payload, {
        ifMatch: version.value ?? undefined,
      });
    } else if (recurrence.value) {
      // Recurring ON: create ONLY the recurring profile (no one-off expense) —
      // the worker generates every occurrence on schedule, avoiding a duplicate
      // "first" expense. An expense has a single amount (no line items), so we
      // map it to a one-line lineItems array (qty 1, unitPrice = the amount) that
      // the profile schema needs. The profile requires a clientId, but expense
      // clientId is optional/free-text — guard blank here (fail before writing);
      // a non-blank but invalid id still 400s at the profile POST.
      if (!trimmedClientId) {
        errorMessage.value = t("recurring.toggle.clientRequired");
        return;
      }
      const profileError = await createProfile({
        documentType: "expense",
        clientId: trimmedClientId,
        currency: currency.value,
        lineItems: [
          {
            description: description.value.trim() || category.value.trim(),
            quantity: 1,
            unitPriceMinor: majorToMinor(amountMajor.value) ?? 0,
          },
        ],
        recurrence: recurrence.value,
        notes: description.value.trim() || null,
      });
      if (profileError) errorMessage.value = profileError;
      return; // stay on the form; snackbar links to the recurring list
    } else {
      await api.post<Expense>("/v1/expenses", payload);
    }
    toast.success(t("expenses.saved"));
    await router.push({ name: "expenses" });
  } catch (err) {
    if (err instanceof ApiError) {
      applyValidationDetails(err);
      errorMessage.value = t("expenses.saveError", { code: err.code });
    } else {
      errorMessage.value = t("expenses.saveErrorGeneric");
    }
    toast.error(errorMessage.value);
  }
};

const applyClone = (): void => {
  if (isEdit.value) return;
  const seed = consumeClone("expense");
  if (!seed) return;
  if (typeof seed.amountMinor === "number") amountMajor.value = minorToMajor(seed.amountMinor);
  if (typeof seed.currency === "string") currency.value = seed.currency;
  if (typeof seed.category === "string") category.value = seed.category;
  if (typeof seed.date === "string") date.value = seed.date;
  if (typeof seed.vendor === "string") vendor.value = seed.vendor;
  if (typeof seed.description === "string") description.value = seed.description;
  if (typeof seed.clientId === "string") clientId.value = seed.clientId;
  if (typeof seed.billable === "boolean") billable.value = seed.billable;
};

onMounted(() => {
  void loadExpense();
  applyClone();
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 12px">
      <v-btn icon="mdi-arrow-left" variant="text" :aria-label="t('common.back')" @click="router.back()" />
      <h1 class="text-h5">{{ isEdit ? t("expenses.editTitle") : t("expenses.newTitle") }}</h1>
    </div>

    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
    </v-alert>

    <v-card v-if="loading" variant="outlined" rounded="lg" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </v-card>

    <v-form v-else ref="formRef" @submit.prevent="submit(save)">
      <AppCard>
        <v-row>
          <v-col cols="12" md="6">
            <v-text-field
              v-model.number="amountMajor"
              :label="t('expenses.fields.amount')"
              type="number"
              :rules="[amountRule]"
              :error-messages="fieldErrors.amountMinor"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="currency"
              :label="t('expenses.fields.currency')"
              :rules="[required, currencyRule]"
              :error-messages="fieldErrors.currency"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="category"
              :label="t('expenses.fields.category')"
              :rules="[required]"
              :error-messages="fieldErrors.category"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="date"
              :label="t('expenses.fields.date')"
              type="date"
              :rules="[required]"
              :error-messages="fieldErrors.date"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="vendor"
              :label="t('expenses.fields.vendor')"
              :rules="[required]"
              :error-messages="fieldErrors.vendor"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <ClientSelector
              v-model="clientId"
              :label="t('expenses.fields.clientId')"
              :error-messages="fieldErrors.clientId"
            />
          </v-col>
          <v-col cols="12" md="6">
            <ProjectSelect v-model="projectId" :error-messages="fieldErrors.projectId" />
          </v-col>
          <v-col cols="12">
            <v-textarea
              v-model="description"
              :label="t('expenses.fields.description')"
              rows="2"
              auto-grow
              :error-messages="fieldErrors.description"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12">
            <v-switch
              v-model="billable"
              :label="t('expenses.fields.billable')"
              color="primary"
              hide-details
              :error-messages="fieldErrors.billable"
            />
          </v-col>
        </v-row>

        <RecurringToggle v-if="!isEdit" v-model="recurrence" :disabled="submitting" />

        <template #actions>
          <v-btn variant="text" @click="router.back()">{{ t("common.cancel") }}</v-btn>
          <v-spacer />
          <v-btn color="primary" type="submit" :loading="submitting">
            {{ isEdit ? t("common.saveChanges") : t("expenses.create") }}
          </v-btn>
        </template>
      </AppCard>
    </v-form>

    <v-snackbar v-model="snackbar" color="success" :timeout="6000">
      {{ snackbarText }}
      <template #actions>
        <v-btn variant="text" :to="{ name: 'recurring-profiles' }">{{ t("recurring.toggle.viewList") }}</v-btn>
      </template>
    </v-snackbar>
  </div>
</template>
