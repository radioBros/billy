<script setup lang="ts">
/**
 * Client create/edit form. One component serves both routes: with an `:id`
 * route param it loads + PATCHes; without, it POSTs a new client. Validation
 * mirrors the backend Zod shape (clients/schema.ts): `type` (company|individual),
 * `displayName` required; `legalName` required when company; `firstName`/`lastName`
 * required when individual. Optional: email, phone, vatNumber, billingAddress
 * (structured), preferredCurrency, tags.
 *
 * The billing address is only sent when at least the required Address sub-fields
 * (line1/city/postalCode/country) are present; a fully-empty address block is
 * omitted rather than sent as a half-filled object the backend would reject.
 * The optimistic-concurrency `version` goes via the If-Match header on PATCH.
 * After save we return to the list route.
 */
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import { LOCALES } from "@billy/shared/locales";
import type { Client } from "@/types/domain";
import AppCard from "@/components/AppCard.vue";
import CountrySelect from "@/components/CountrySelect.vue";
import AddressAutocomplete, { type ResolvedAddress } from "@/components/AddressAutocomplete.vue";
import { useFormSubmit, type VuetifyFormRef } from "@/composables/useFormSubmit";
import { useToast } from "@/composables/useToast";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const id = computed<string | null>(() => (route.params.id as string | undefined) ?? null);
const isEdit = computed<boolean>(() => id.value !== null);

type ClientType = "company" | "individual";

const TYPE_OPTIONS = computed(() => [
  { title: t("clients.form.typeCompany"), value: "company" as ClientType },
  { title: t("clients.form.typeIndividual"), value: "individual" as ClientType },
]);

const type = ref<ClientType>("company");
const displayName = ref("");
const legalName = ref("");
const firstName = ref("");
const lastName = ref("");
const email = ref("");
const phone = ref("");
const vatNumber = ref("");
const preferredCurrency = ref("");
// The client's language — their documents + emails render in it (falls back to
// the company default, then English).
const preferredLanguage = ref<string | null>(null);
// "First Last" contact-person (referral / attention-of).
const referral = ref("");
const tags = ref<string[]>([]);

// Structured billing address (Address: line1/city/postalCode/country required
// once any field is filled; line2/region optional).
const addrLine1 = ref("");
const addrLine2 = ref("");
const addrCity = ref("");
const addrRegion = ref("");
const addrPostalCode = ref("");
const addrCountry = ref("");

/** Fill every address field from an autocomplete-resolved address (incl. the
 *  civic/house number, appended to line1 by the component). */
const fillAddress = (a: ResolvedAddress): void => {
  addrLine1.value = a.line1;
  if (a.city) addrCity.value = a.city;
  if (a.region) addrRegion.value = a.region;
  if (a.postalCode) addrPostalCode.value = a.postalCode;
  if (a.country) addrCountry.value = a.country;
};

const version = ref<number | null>(null);

const loading = ref(false);
const errorMessage = ref<string | null>(null);
const fieldErrors = ref<Record<string, string>>({});

const formRef = ref<VuetifyFormRef | null>(null);
const { submit, submitting } = useFormSubmit(formRef);
const { toast } = useToast();

const isCompany = computed(() => type.value === "company");
const isIndividual = computed(() => type.value === "individual");

const required = (v: unknown): boolean | string =>
  (!!v && String(v).trim().length > 0) || t("common.required");
const emailRule = (v: string): boolean | string =>
  !v || /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(v) || t("clients.form.emailRule");
const currencyRule = (v: string): boolean | string =>
  !v || /^[A-Z]{3}$/u.test(v) || t("common.currencyRule");

/** Language dropdown options — driven by the shared LOCALES source of truth. */
const localeItems = LOCALES.map((l) => ({ title: l.nativeName, value: l.code }));

// Any address field filled → the required Address sub-fields become required.
const addressTouched = computed(
  () =>
    !!(
      addrLine1.value ||
      addrLine2.value ||
      addrCity.value ||
      addrRegion.value ||
      addrPostalCode.value ||
      addrCountry.value
    ),
);
const addrRequired = (v: unknown): boolean | string =>
  !addressTouched.value || (!!v && String(v).trim().length > 0) || t("common.required");

const loadClient = async (): Promise<void> => {
  if (!id.value) return;
  loading.value = true;
  errorMessage.value = null;
  try {
    const client = await api.get<Client>(`/v1/clients/${id.value}`);
    type.value = client.type;
    displayName.value = client.displayName ?? "";
    legalName.value = client.legalName ?? "";
    firstName.value = client.firstName ?? "";
    lastName.value = client.lastName ?? "";
    email.value = client.email ?? "";
    phone.value = client.phone ?? "";
    vatNumber.value = client.vatNumber ?? "";
    preferredCurrency.value = client.preferredCurrency ?? "";
    preferredLanguage.value = client.preferredLanguage ?? null;
    referral.value = client.referral ?? "";
    tags.value = client.tags ?? [];
    const a = client.billingAddress;
    addrLine1.value = a?.line1 ?? "";
    addrLine2.value = a?.line2 ?? "";
    addrCity.value = a?.city ?? "";
    addrRegion.value = a?.region ?? "";
    addrPostalCode.value = a?.postalCode ?? "";
    addrCountry.value = a?.country ?? "";
    version.value = client.version;
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError
        ? t("clients.loadOneError", { code: err.code })
        : t("clients.loadOneErrorGeneric");
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

const buildPayload = (): Record<string, unknown> => {
  const payload: Record<string, unknown> = {
    type: type.value,
    displayName: displayName.value.trim(),
    tags: tags.value.map((s) => s.trim()).filter(Boolean),
  };
  // Conditional-required naming fields per backend refineByType.
  if (isCompany.value) {
    payload.legalName = legalName.value.trim() || undefined;
  } else {
    payload.firstName = firstName.value.trim() || undefined;
    payload.lastName = lastName.value.trim() || undefined;
  }
  if (email.value.trim()) payload.email = email.value.trim();
  if (phone.value.trim()) payload.phone = phone.value.trim();
  if (vatNumber.value.trim()) payload.vatNumber = vatNumber.value.trim();
  if (preferredCurrency.value.trim()) payload.preferredCurrency = preferredCurrency.value.trim();
  if (preferredLanguage.value) payload.preferredLanguage = preferredLanguage.value;
  if (referral.value.trim()) payload.referral = referral.value.trim();
  if (addressTouched.value) {
    payload.billingAddress = {
      line1: addrLine1.value.trim(),
      ...(addrLine2.value.trim() ? { line2: addrLine2.value.trim() } : {}),
      city: addrCity.value.trim(),
      ...(addrRegion.value.trim() ? { region: addrRegion.value.trim() } : {}),
      postalCode: addrPostalCode.value.trim(),
      country: addrCountry.value.trim(),
    };
  }
  return payload;
};

const save = async (): Promise<void> => {
  errorMessage.value = null;
  fieldErrors.value = {};
  try {
    const payload = buildPayload();
    if (isEdit.value && id.value) {
      await api.patch<Client>(`/v1/clients/${id.value}`, payload, {
        ifMatch: version.value ?? undefined,
      });
    } else {
      await api.post<Client>("/v1/clients", payload);
    }
    toast.success(t("clients.saved"));
    await router.push({ name: "clients" });
  } catch (err) {
    if (err instanceof ApiError) {
      applyValidationDetails(err);
      errorMessage.value = t("clients.saveError", { code: err.code });
    } else {
      errorMessage.value = t("clients.saveErrorGeneric");
    }
    toast.error(errorMessage.value);
  }
};

onMounted(() => {
  void loadClient();
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 12px">
      <v-btn icon="mdi-arrow-left" variant="text" :aria-label="t('common.back')" @click="router.back()" />
      <h1 class="text-h5">{{ isEdit ? t("clients.editTitle") : t("clients.newTitle") }}</h1>
    </div>

    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
    </v-alert>

    <v-card v-if="loading" variant="outlined" rounded="lg" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </v-card>

    <v-form v-else ref="formRef" @submit.prevent="submit(save)">
      <AppCard :title="t('clients.form.details')">
        <v-row>
          <v-col cols="12" md="6">
            <v-select
              v-model="type"
              :items="TYPE_OPTIONS"
              :label="t('clients.fields.type')"
              :rules="[required]"
              :error-messages="fieldErrors.type"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="displayName"
              :label="t('clients.fields.displayName')"
              :rules="[required]"
              :error-messages="fieldErrors.displayName"
              density="comfortable"
            />
          </v-col>

          <v-col v-if="isCompany" cols="12" md="6">
            <v-text-field
              v-model="legalName"
              :label="t('clients.fields.legalName')"
              :rules="[required]"
              :error-messages="fieldErrors.legalName"
              density="comfortable"
            />
          </v-col>

          <template v-if="isIndividual">
            <v-col cols="12" md="6">
              <v-text-field
                v-model="firstName"
                :label="t('clients.fields.firstName')"
                :rules="[required]"
                :error-messages="fieldErrors.firstName"
                density="comfortable"
              />
            </v-col>
            <v-col cols="12" md="6">
              <v-text-field
                v-model="lastName"
                :label="t('clients.fields.lastName')"
                :rules="[required]"
                :error-messages="fieldErrors.lastName"
                density="comfortable"
              />
            </v-col>
          </template>

          <v-col cols="12" md="6">
            <v-text-field
              v-model="email"
              :label="t('clients.fields.email')"
              type="email"
              :rules="[emailRule]"
              :error-messages="fieldErrors.email"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="phone"
              :label="t('clients.fields.phone')"
              :error-messages="fieldErrors.phone"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="vatNumber"
              :label="t('clients.fields.vatNumber')"
              :error-messages="fieldErrors.vatNumber"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="preferredCurrency"
              :label="t('clients.fields.preferredCurrency')"
              :rules="[currencyRule]"
              :error-messages="fieldErrors.preferredCurrency"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-select
              v-model="preferredLanguage"
              :items="localeItems"
              :label="t('clients.fields.preferredLanguage')"
              :hint="t('clients.form.languageHint')"
              persistent-hint
              clearable
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="referral"
              :label="t('clients.fields.referral')"
              :error-messages="fieldErrors.referral"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12">
            <v-combobox
              v-model="tags"
              :label="t('clients.fields.tags')"
              :error-messages="fieldErrors.tags"
              density="comfortable"
              multiple
              chips
              closable-chips
              clearable
              :hint="t('clients.form.tagsHint')"
              persistent-hint
            />
          </v-col>
        </v-row>
      </AppCard>

      <AppCard :title="t('clients.form.billingAddress')">
        <v-row>
          <v-col cols="12" md="8">
            <AddressAutocomplete
              v-model="addrLine1"
              :label="t('clients.fields.addrLine1')"
              :rules="[addrRequired]"
              :error-messages="fieldErrors['billingAddress.line1']"
              @resolved="fillAddress"
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-text-field
              v-model="addrLine2"
              :label="t('clients.fields.addrLine2')"
              :error-messages="fieldErrors['billingAddress.line2']"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-text-field
              v-model="addrCity"
              :label="t('clients.fields.addrCity')"
              :rules="[addrRequired]"
              :error-messages="fieldErrors['billingAddress.city']"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="2">
            <v-text-field
              v-model="addrRegion"
              :label="t('clients.fields.addrRegion')"
              :error-messages="fieldErrors['billingAddress.region']"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="2">
            <v-text-field
              v-model="addrPostalCode"
              :label="t('clients.fields.addrPostalCode')"
              :rules="[addrRequired]"
              :error-messages="fieldErrors['billingAddress.postalCode']"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="4">
            <CountrySelect
              v-model="addrCountry"
              :label="t('clients.fields.addrCountry')"
              :rules="[addrRequired]"
              :error-messages="fieldErrors['billingAddress.country']"
              clearable
            />
          </v-col>
        </v-row>
        <template #actions>
          <v-btn variant="text" @click="router.back()">{{ t("common.cancel") }}</v-btn>
          <v-spacer />
          <v-btn color="primary" type="submit" :loading="submitting">
            {{ isEdit ? t("common.saveChanges") : t("clients.create") }}
          </v-btn>
        </template>
      </AppCard>
    </v-form>
  </div>
</template>
