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
import { translateValidationDetails, apiErrorReason } from "@/utils/validationMessages";
import type { TimeEntry } from "@/types/domain";
import ClientSelector from "@/components/ClientSelector.vue";
import AppCard from "@/components/AppCard.vue";
import { majorToMinor, minorToMajor } from "@/utils/money";
import { useFormSubmit, type VuetifyFormRef } from "@/composables/useFormSubmit";
import { useToast } from "@/composables/useToast";
import { useIsMobile } from "@/composables/useIsMobile";
import { createReusableTemplate } from "@/composables/useReusableTemplate";
import PageHeader from "@/components/PageHeader.vue";
import FormSteps from "@/components/FormSteps.vue";
import type { FormStep } from "@/components/FormSteps.vue";
import FormActions from "@/components/FormActions.vue";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const id = computed<string | null>(() => (route.params.id as string | undefined) ?? null);
const isEdit = computed<boolean>(() => id.value !== null);
const isMobile = useIsMobile();

/** Phone wizard steps. Desktop keeps the single card — both layouts render the
 *  same field groups via the reusable templates below. */
const formSteps = computed<FormStep[]>(() => [
  { key: "details", title: t("formSteps.details"), icon: "mdi-clock-outline" },
  { key: "billing", title: t("formSteps.billing"), icon: "mdi-cash-clock" },
]);
const { Define: DefineWork, Reuse: ReuseWork } = createReusableTemplate();
const { Define: DefineBilling, Reuse: ReuseBilling } = createReusableTemplate();

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
        ? t("timeEntries.loadOneError", { code: apiErrorReason(err) })
        : t("timeEntries.loadOneErrorGeneric");
  } finally {
    loading.value = false;
  }
};

const applyValidationDetails = (err: ApiError): void => {
  // Values arrive as machine codes ("field.required") — translate for display.
  fieldErrors.value = translateValidationDetails(err.details);
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
      errorMessage.value = t("timeEntries.saveError", { code: apiErrorReason(err) });
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
    <!-- Field groups, defined once: the desktop card and the phone steps below
         both render them (see composables/useReusableTemplate). -->
    <DefineWork>
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
    </DefineWork>
    <DefineBilling>
      <v-col cols="12" md="6" :class="{ 'pb-3': isMobile }">
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
      <v-col cols="12" md="6" class="d-flex align-center" :class="{ 'py-2': isMobile }">
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
      <v-col cols="12" md="6" :class="{ 'pb-3': isMobile }">
        <v-text-field
          v-model="projectId"
          :label="t('timeEntries.fields.projectId')"
          :error-messages="fieldErrors.projectId"
          density="comfortable"
          :hint="t('timeEntries.projectIdHint')"
          persistent-hint
        />
      </v-col>
    </DefineBilling>

    <PageHeader back :title="isEdit ? t('timeEntries.editTitle') : t('timeEntries.newTitle')" />

    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
    </v-alert>

    <v-card v-if="loading" variant="outlined" rounded="lg" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </v-card>

    <v-form v-else ref="formRef" @submit.prevent="submit(save)">
      <!-- Phone: details → billing (rate / billable / client / project) wizard. -->
      <FormSteps v-if="isMobile" :steps="formSteps">
        <template #details>
          <AppCard>
            <v-row>
              <ReuseWork />
            </v-row>
          </AppCard>
        </template>
        <template #billing>
          <AppCard>
            <v-row>
              <ReuseBilling />
            </v-row>
          </AppCard>
        </template>
        <template #actions>
          <FormActions>
            <v-btn color="primary" variant="flat" type="submit" :loading="submitting">
              {{ isEdit ? t("common.saveChanges") : t("timeEntries.create") }}
            </v-btn>
          </FormActions>
        </template>
      </FormSteps>

      <AppCard v-else>
        <v-row>
          <ReuseWork />
          <ReuseBilling />
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
