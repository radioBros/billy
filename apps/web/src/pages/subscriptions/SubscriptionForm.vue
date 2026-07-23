<script setup lang="ts">
/**
 * Subscription create/edit form. One component serves both routes: with an `:id`
 * route param it loads + PATCHes; without, it POSTs a new subscription.
 * Validation mirrors the backend Zod shape: clientId, name, plan, amount (> 0),
 * currency (ISO-4217), interval, startDate, nextBillingDate (≥ startDate).
 *
 * Both create and update schemas are `.strict()`, so we send ONLY the whitelisted
 * keys. Create includes clientId; PATCH does NOT (clientId is immutable) and
 * never carries `status`/`lastPaidAt` (status changes are separate action routes).
 * The optimistic-concurrency `version` goes via the If-Match header, never the
 * body (the strict PATCH schema rejects an unknown `version` key). Amount is
 * entered in major units and converted with majorToMinor. After save we return
 * to the list route.
 */
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import type { Subscription, SubscriptionInterval } from "@/types/domain";
import { majorToMinor, minorToMajor } from "@/utils/money";
import ClientSelector from "@/components/ClientSelector.vue";
import ProjectSelect from "@/components/ProjectSelect.vue";
import AppCard from "@/components/AppCard.vue";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const id = computed<string | null>(() => (route.params.id as string | undefined) ?? null);
const isEdit = computed<boolean>(() => id.value !== null);

const INTERVAL_VALUES: SubscriptionInterval[] = ["weekly", "monthly", "quarterly", "yearly"];
// Display each interval via the shared recurring.interval.* labels (translated in
// all locales) while keeping the raw enum value as the v-model binding.
const INTERVAL_OPTIONS = computed(() =>
  INTERVAL_VALUES.map((v) => ({ title: t(`recurring.interval.${v}`), value: v })),
);

const clientId = ref<string | null>(null);
const projectId = ref<string | null>(null);
const name = ref("");
const plan = ref("");
const amountMajor = ref<number | null>(null);
const currency = ref("EUR");
const interval = ref<SubscriptionInterval>("monthly");
const startDate = ref(new Date().toISOString().slice(0, 10));
const nextBillingDate = ref(new Date().toISOString().slice(0, 10));
const url = ref("");
const note = ref("");
const version = ref<number | null>(null);

const loading = ref(false);
const saving = ref(false);
const errorMessage = ref<string | null>(null);
const fieldErrors = ref<Record<string, string>>({});
const formValid = ref(false);

const required = (v: unknown): boolean | string =>
  (!!v && String(v).trim().length > 0) || t("common.required");
const currencyRule = (v: string): boolean | string =>
  /^[A-Z]{3}$/u.test(v) || t("common.currencyRule");
const amountRule = (v: number | null): boolean | string => {
  if (v === null || (v as unknown) === "") return t("subscriptions.amountRequired");
  return Number(v) > 0 || t("subscriptions.amountRule");
};
const nextBillingRule = (v: string): boolean | string =>
  !startDate.value || !v || v >= startDate.value || t("subscriptions.nextBillingRule");
const urlRule = (v: string): boolean | string => {
  if (!v || !v.trim()) return true;
  try {
    new URL(v.trim());
    return true;
  } catch {
    return t("subscriptions.urlRule");
  }
};

const loadSubscription = async (): Promise<void> => {
  if (!id.value) return;
  loading.value = true;
  errorMessage.value = null;
  try {
    const sub = await api.get<Subscription>(`/v1/subscriptions/${id.value}`);
    clientId.value = sub.clientId ?? null;
    projectId.value = sub.projectId ?? null;
    name.value = sub.name;
    plan.value = sub.plan;
    amountMajor.value = minorToMajor(sub.amountMinor);
    currency.value = sub.currency;
    interval.value = sub.interval;
    startDate.value = sub.startDate;
    nextBillingDate.value = sub.nextBillingDate;
    url.value = sub.url ?? "";
    note.value = sub.note ?? "";
    version.value = sub.version;
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError
        ? t("subscriptions.loadOneError", { code: err.code })
        : t("subscriptions.loadOneErrorGeneric");
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
  saving.value = true;
  const amountMinor = majorToMinor(amountMajor.value);
  try {
    if (isEdit.value && id.value) {
      // PATCH: strict schema — omit clientId (immutable), status, lastPaidAt.
      const payload: Record<string, unknown> = {
        name: name.value.trim(),
        plan: plan.value.trim(),
        currency: currency.value.trim(),
        interval: interval.value,
        startDate: startDate.value,
        nextBillingDate: nextBillingDate.value,
      };
      if (amountMinor !== null) payload.amountMinor = amountMinor;
      // url/note: send trimmed value, or null to clear (schema is .nullable()).
      payload.url = url.value.trim() || null;
      payload.note = note.value.trim() || null;
      await api.patch<Subscription>(`/v1/subscriptions/${id.value}`, payload, {
        ifMatch: version.value ?? undefined,
      });
    } else {
      // POST: strict schema — send exactly the create keys. clientId is optional:
      // omit it entirely when no client is selected.
      const payload: Record<string, unknown> = {
        name: name.value.trim(),
        plan: plan.value.trim(),
        amountMinor,
        currency: currency.value.trim(),
        interval: interval.value,
        startDate: startDate.value,
        nextBillingDate: nextBillingDate.value,
      };
      if (clientId.value) payload.clientId = clientId.value;
      if (projectId.value) payload.projectId = projectId.value;
      if (url.value.trim()) payload.url = url.value.trim();
      if (note.value.trim()) payload.note = note.value.trim();
      await api.post<Subscription>("/v1/subscriptions", payload);
    }
    await router.push({ name: "subscriptions" });
  } catch (err) {
    if (err instanceof ApiError) {
      applyValidationDetails(err);
      errorMessage.value = t("subscriptions.saveError", { code: err.code });
    } else {
      errorMessage.value = t("subscriptions.saveErrorGeneric");
    }
  } finally {
    saving.value = false;
  }
};

onMounted(() => {
  void loadSubscription();
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 12px">
      <v-btn icon="mdi-arrow-left" variant="text" :aria-label="t('common.back')" @click="router.back()" />
      <h1 class="text-h5">{{ isEdit ? t("subscriptions.editTitle") : t("subscriptions.newTitle") }}</h1>
    </div>

    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
    </v-alert>

    <v-card v-if="loading" variant="outlined" rounded="lg" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </v-card>

    <v-form v-else v-model="formValid" @submit.prevent="save">
      <AppCard>
        <v-row>
          <v-col cols="12" md="6">
            <ClientSelector
              v-model="clientId"
              :label="t('subscriptions.fields.client')"
              :disabled="isEdit"
              :error-messages="fieldErrors.clientId"
            />
          </v-col>
          <v-col cols="12" md="6">
            <ProjectSelect v-model="projectId" :error-messages="fieldErrors.projectId" />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="name"
              :label="t('subscriptions.fields.name')"
              :rules="[required]"
              :error-messages="fieldErrors.name"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="plan"
              :label="t('subscriptions.fields.plan')"
              :rules="[required]"
              :error-messages="fieldErrors.plan"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model.number="amountMajor"
              :label="t('subscriptions.fields.amount')"
              type="number"
              min="0"
              step="0.01"
              :rules="[amountRule]"
              :error-messages="fieldErrors.amountMinor"
              density="comfortable"
              :hint="t('subscriptions.amountHint')"
              persistent-hint
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="currency"
              :label="t('subscriptions.fields.currency')"
              :rules="[required, currencyRule]"
              :error-messages="fieldErrors.currency"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-select
              v-model="interval"
              :items="INTERVAL_OPTIONS"
              :label="t('subscriptions.fields.interval')"
              :rules="[required]"
              :error-messages="fieldErrors.interval"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="startDate"
              :label="t('subscriptions.fields.startDate')"
              type="date"
              :rules="[required]"
              :error-messages="fieldErrors.startDate"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="nextBillingDate"
              :label="t('subscriptions.fields.nextBillingDate')"
              type="date"
              :rules="[required, nextBillingRule]"
              :error-messages="fieldErrors.nextBillingDate"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="url"
              :label="t('subscriptions.fields.url')"
              type="url"
              :rules="[urlRule]"
              :error-messages="fieldErrors.url"
              density="comfortable"
              :hint="t('subscriptions.urlHint')"
              persistent-hint
            />
          </v-col>
          <v-col cols="12">
            <v-textarea
              v-model="note"
              :label="t('subscriptions.fields.note')"
              :error-messages="fieldErrors.note"
              density="comfortable"
              rows="3"
              auto-grow
            />
          </v-col>
        </v-row>
        <template #actions>
          <v-btn variant="text" @click="router.back()">{{ t("common.cancel") }}</v-btn>
          <v-spacer />
          <v-btn color="primary" type="submit" :loading="saving">
            {{ isEdit ? t("common.saveChanges") : t("subscriptions.create") }}
          </v-btn>
        </template>
      </AppCard>
    </v-form>
  </div>
</template>
