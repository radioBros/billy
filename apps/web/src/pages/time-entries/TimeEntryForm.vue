<script setup lang="ts">
/**
 * Time entry create/edit form. One component serves both routes: with an `:id`
 * route param it loads + PATCHes; without, it POSTs a new entry. Validation
 * mirrors the backend Zod shape: description (non-empty), date (YYYY-MM-DD),
 * durationMinutes (int ≥ 0), billable (boolean), optional rateMinor.
 *
 * Money (rateMinor) is entered in major units and converted with majorToMinor;
 * it is optional so we omit the key when blank rather than send null. On PATCH
 * the optimistic-concurrency `version` goes via the If-Match header, never the
 * body. Server-owned fields (userId, billed, invoiceId, timer state) are never
 * sent. After save we return to the list route.
 */
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import type { TimeEntry } from "@/types/domain";
import ClientSelector from "@/components/ClientSelector.vue";
import AppCard from "@/components/AppCard.vue";
import { majorToMinor, minorToMajor } from "@/utils/money";
import { useFormSubmit, type VuetifyFormRef } from "@/composables/useFormSubmit";
import { useToast } from "@/composables/useToast";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const id = computed<string | null>(() => (route.params.id as string | undefined) ?? null);
const isEdit = computed<boolean>(() => id.value !== null);

const description = ref("");
const date = ref(new Date().toISOString().slice(0, 10));
const durationMinutes = ref<number | null>(0);
const billable = ref(true);
const rateMajor = ref<number | null>(null);
const clientId = ref<string | null>("");
const projectId = ref("");
const version = ref<number | null>(null);

const loading = ref(false);
const errorMessage = ref<string | null>(null);
const fieldErrors = ref<Record<string, string>>({});

const formRef = ref<VuetifyFormRef | null>(null);
const { submit, submitting } = useFormSubmit(formRef);
const { toast } = useToast();

const required = (v: unknown): boolean | string =>
  (!!v && String(v).trim().length > 0) || t("common.required");
const durationRule = (v: number | null): boolean | string => {
  if (v === null || (v as unknown) === "") return t("common.required");
  const n = Number(v);
  return (Number.isInteger(n) && n >= 0) || t("timeEntries.durationRule");
};

const loadTimeEntry = async (): Promise<void> => {
  if (!id.value) return;
  loading.value = true;
  errorMessage.value = null;
  try {
    const entry = await api.get<TimeEntry>(`/v1/time-entries/${id.value}`);
    description.value = entry.description;
    date.value = entry.date;
    durationMinutes.value = entry.durationMinutes;
    billable.value = entry.billable;
    rateMajor.value = minorToMajor(entry.rateMinor);
    clientId.value = entry.clientId ?? "";
    projectId.value = entry.projectId ?? "";
    version.value = entry.version;
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError
        ? t("timeEntries.loadOneError", { code: err.code })
        : t("timeEntries.loadOneErrorGeneric");
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
  const rateMinor = majorToMinor(rateMajor.value);
  const payload: Record<string, unknown> = {
    description: description.value.trim(),
    date: date.value,
    durationMinutes: Number(durationMinutes.value ?? 0),
    billable: billable.value,
  };
  if (clientId.value?.trim()) payload.clientId = clientId.value.trim();
  if (projectId.value.trim()) payload.projectId = projectId.value.trim();
  if (rateMinor !== null) payload.rateMinor = rateMinor;
  try {
    if (isEdit.value && id.value) {
      await api.patch<TimeEntry>(`/v1/time-entries/${id.value}`, payload, {
        ifMatch: version.value ?? undefined,
      });
    } else {
      await api.post<TimeEntry>("/v1/time-entries", payload);
    }
    toast.success(t("timeEntries.saved"));
    await router.push({ name: "time-entries" });
  } catch (err) {
    if (err instanceof ApiError) {
      applyValidationDetails(err);
      errorMessage.value = t("timeEntries.saveError", { code: err.code });
    } else {
      errorMessage.value = t("timeEntries.saveErrorGeneric");
    }
    toast.error(errorMessage.value);
  }
};

onMounted(() => {
  void loadTimeEntry();
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 12px">
      <v-btn icon="mdi-arrow-left" variant="text" :aria-label="t('common.back')" @click="router.back()" />
      <h1 class="text-h5">{{ isEdit ? t("timeEntries.editTitle") : t("timeEntries.newTitle") }}</h1>
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
          <v-col cols="12">
            <v-text-field
              v-model="description"
              :label="t('timeEntries.fields.description')"
              :rules="[required]"
              :error-messages="fieldErrors.description"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="date"
              :label="t('timeEntries.fields.date')"
              type="date"
              :rules="[required]"
              :error-messages="fieldErrors.date"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model.number="durationMinutes"
              :label="t('timeEntries.fields.duration')"
              type="number"
              min="0"
              step="1"
              :rules="[durationRule]"
              :error-messages="fieldErrors.durationMinutes"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model.number="rateMajor"
              :label="t('timeEntries.fields.rate')"
              type="number"
              min="0"
              step="0.01"
              :error-messages="fieldErrors.rateMinor"
              density="comfortable"
              :hint="t('timeEntries.rateHint')"
              persistent-hint
            />
          </v-col>
          <v-col cols="12" md="6" class="d-flex align-center">
            <v-switch
              v-model="billable"
              :label="t('timeEntries.fields.billable')"
              color="primary"
              density="comfortable"
              hide-details
            />
          </v-col>
          <v-col cols="12" md="6">
            <ClientSelector
              v-model="clientId"
              :label="t('timeEntries.fields.clientId')"
              :error-messages="fieldErrors.clientId"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="projectId"
              :label="t('timeEntries.fields.projectId')"
              :error-messages="fieldErrors.projectId"
              density="comfortable"
              :hint="t('timeEntries.projectIdHint')"
              persistent-hint
            />
          </v-col>
        </v-row>
        <template #actions>
          <v-btn variant="text" @click="router.back()">{{ t("common.cancel") }}</v-btn>
          <v-spacer />
          <v-btn color="primary" type="submit" :loading="submitting">
            {{ isEdit ? t("common.saveChanges") : t("timeEntries.create") }}
          </v-btn>
        </template>
      </AppCard>
    </v-form>
  </div>
</template>
