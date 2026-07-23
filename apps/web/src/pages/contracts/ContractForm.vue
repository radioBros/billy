<script setup lang="ts">
/**
 * Contract create/edit form. One component serves both routes: with an `:id`
 * route param it loads + PATCHes; without, it POSTs a new contract. Validation
 * mirrors the backend Zod shape: clientId, title, type, startDate required;
 * endDate (when present) must be on/after startDate. `status` is never
 * client-set — the server owns it.
 *
 * Money (value) is entered in MAJOR units via a local ref and converted to
 * integer minor units with majorToMinor() when building the payload. On PATCH we
 * send the optimistic-concurrency `version` via the If-Match header.
 */
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import type { Contract, ContractType } from "@/types/domain";
import { majorToMinor, minorToMajor } from "@/utils/money";
import { enumLabel } from "@/utils/enums";
import AutocompleteSearch from "@/components/AutocompleteSearch.vue";
import type { AutocompleteItem } from "@/components/AutocompleteSearch.vue";
import RichTextEditor from "@/components/RichTextEditor.vue";
import ClientSelector from "@/components/ClientSelector.vue";
import ProjectSelect from "@/components/ProjectSelect.vue";
import AppCard from "@/components/AppCard.vue";
import { consumeClone } from "@/composables/useClonePrefill";
import { useFormSubmit, type VuetifyFormRef } from "@/composables/useFormSubmit";
import { useToast } from "@/composables/useToast";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const id = computed<string | null>(() => (route.params.id as string | undefined) ?? null);
const isEdit = computed<boolean>(() => id.value !== null);

const TYPE_OPTIONS: ContractType[] = [
  "development",
  "maintenance",
  "hosting",
  "support",
  "consulting",
  "service_agreement",
  "retainer",
  "other",
];
// >4 options → AutocompleteSearch (static). Map each code to its translated
// label while keeping the raw code as the submitted value.
const TYPE_ITEMS = computed(
  () =>
    TYPE_OPTIONS.map((v) => ({ title: enumLabel(t, "contractType", v), value: v })) as unknown as AutocompleteItem[],
);

const clientId = ref<string | null>("");
const projectId = ref<string | null>(null);
const title = ref("");
const type = ref<ContractType | null>(null);
const startDate = ref(new Date().toISOString().slice(0, 10));
const endDate = ref("");
const valueMajor = ref<number | null>(null);
const currency = ref("EUR");
const terms = ref("");
const notes = ref("");
const version = ref<number | null>(null);

const loading = ref(false);
const errorMessage = ref<string | null>(null);
const fieldErrors = ref<Record<string, string>>({});

const formRef = ref<VuetifyFormRef | null>(null);
const { submit, submitting } = useFormSubmit(formRef);
const { toast } = useToast();

const required = (v: unknown): true | string =>
  (!!v && String(v).trim().length > 0) || t("common.required");
const currencyRule = (v: string): boolean | string =>
  !v || /^[A-Z]{3}$/u.test(v) || t("common.currencyRule");
const endDateRule = (v: string): boolean | string =>
  !endDate.value || !startDate.value || v >= startDate.value || t("contracts.endDateRule");

const loadContract = async (): Promise<void> => {
  if (!id.value) return;
  loading.value = true;
  errorMessage.value = null;
  try {
    const c = await api.get<Contract>(`/v1/contracts/${id.value}`);
    clientId.value = c.clientId;
    projectId.value = c.projectId ?? null;
    title.value = c.title;
    type.value = c.type;
    startDate.value = c.startDate;
    endDate.value = c.endDate ?? "";
    valueMajor.value = minorToMajor(c.valueMinor);
    currency.value = c.currency ?? "EUR";
    terms.value = c.terms ?? "";
    notes.value = c.notes ?? "";
    version.value = c.version;
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError
        ? t("contracts.loadOneError", { code: err.code })
        : t("contracts.loadOneErrorGeneric");
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
    title: title.value,
    type: type.value,
    startDate: startDate.value,
    endDate: endDate.value || null,
    valueMinor: majorToMinor(valueMajor.value),
    currency: currency.value.trim() || null,
    terms: terms.value.trim() || null,
    notes: notes.value.trim() || null,
  };
  try {
    if (isEdit.value && id.value) {
      await api.patch<Contract>(`/v1/contracts/${id.value}`, payload, {
        ifMatch: version.value ?? undefined,
      });
    } else {
      await api.post<Contract>("/v1/contracts", payload);
    }
    toast.success(t("contracts.saved"));
    await router.push({ name: "contracts" });
  } catch (err) {
    if (err instanceof ApiError) {
      applyValidationDetails(err);
      errorMessage.value = t("contracts.saveError", { code: err.code });
    } else {
      errorMessage.value = t("contracts.saveErrorGeneric");
    }
    toast.error(errorMessage.value);
  }
};

const applyClone = (): void => {
  if (isEdit.value) return;
  const seed = consumeClone("contract");
  if (!seed) return;
  if (typeof seed.clientId === "string") clientId.value = seed.clientId;
  if (typeof seed.title === "string") title.value = seed.title;
  if (typeof seed.type === "string") type.value = seed.type as ContractType;
  if (typeof seed.startDate === "string") startDate.value = seed.startDate;
  if (typeof seed.endDate === "string") endDate.value = seed.endDate;
  if (typeof seed.valueMinor === "number") valueMajor.value = minorToMajor(seed.valueMinor);
  if (typeof seed.currency === "string") currency.value = seed.currency;
  if (typeof seed.terms === "string") terms.value = seed.terms;
  if (typeof seed.notes === "string") notes.value = seed.notes;
};

onMounted(() => {
  void loadContract();
  applyClone();
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 12px">
      <v-btn icon="mdi-arrow-left" variant="text" :aria-label="t('common.back')" @click="router.back()" />
      <h1 class="text-h5">{{ isEdit ? t("contracts.editTitle") : t("contracts.newTitle") }}</h1>
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
            <ClientSelector
              v-model="clientId"
              :label="t('contracts.fields.clientId')"
              :rules="[required]"
              :error-messages="fieldErrors.clientId"
            />
          </v-col>
          <v-col cols="12" md="6">
            <ProjectSelect v-model="projectId" :error-messages="fieldErrors.projectId" />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="title"
              :label="t('contracts.fields.title')"
              :rules="[required]"
              :error-messages="fieldErrors.title"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <AutocompleteSearch
              v-model="type"
              :items="TYPE_ITEMS"
              :label="t('contracts.fields.type')"
              :rules="[required]"
              :error-messages="fieldErrors.type"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="startDate"
              :label="t('contracts.fields.startDate')"
              type="date"
              :rules="[required]"
              :error-messages="fieldErrors.startDate"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="endDate"
              :label="t('contracts.fields.endDate')"
              type="date"
              :rules="[endDateRule]"
              :error-messages="fieldErrors.endDate"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="3">
            <v-text-field
              v-model.number="valueMajor"
              :label="t('contracts.fields.value')"
              type="number"
              :error-messages="fieldErrors.valueMinor"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="3">
            <v-text-field
              v-model="currency"
              :label="t('contracts.fields.currency')"
              :rules="[currencyRule]"
              :error-messages="fieldErrors.currency"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12">
            <!-- Contract content body: a full WYSIWYG (rich text + HTML source),
                 not a plain textarea — the terms are the main body of the contract. -->
            <RichTextEditor v-model="terms" :label="t('contracts.fields.terms')" />
            <div v-if="fieldErrors.terms" class="text-error text-caption mt-1">{{ fieldErrors.terms }}</div>
          </v-col>
          <v-col cols="12">
            <v-textarea
              v-model="notes"
              :label="t('contracts.fields.notes')"
              rows="2"
              auto-grow
              :error-messages="fieldErrors.notes"
              density="comfortable"
            />
          </v-col>
        </v-row>
        <template #actions>
          <v-btn variant="text" @click="router.back()">{{ t("common.cancel") }}</v-btn>
          <v-spacer />
          <v-btn color="primary" type="submit" :loading="submitting">
            {{ isEdit ? t("common.saveChanges") : t("contracts.create") }}
          </v-btn>
        </template>
      </AppCard>
    </v-form>
  </div>
</template>
