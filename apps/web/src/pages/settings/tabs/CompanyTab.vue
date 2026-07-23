<script setup lang="ts">
/** Company tab — GET/PATCH /v1/settings/business (company details on documents). */
import { ref, computed, onMounted, inject } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import type {
  Address,
  BankAccount,
  BusinessSettings,
  DocumentSettings,
  DocumentDesignSettings,
} from "@/types/domain";
import { uploadFile, logoUrlFor } from "@/api/files";
import { useFieldErrors } from "@/pages/settings/useFieldErrors";
import { SNACKBAR_KEY, NOOP_NOTIFY } from "@/pages/settings/snackbar";
import BankAccountsEditor from "@/pages/settings/BankAccountsEditor.vue";
import CountrySelect from "@/components/CountrySelect.vue";
import AddressAutocomplete, { type ResolvedAddress } from "@/components/AddressAutocomplete.vue";

const { t } = useI18n();
const notify = inject(SNACKBAR_KEY, NOOP_NOTIFY);
const { fieldErrors, applyError, clear } = useFieldErrors();

const loading = ref(false);
const saving = ref(false);
const uploading = ref(false);
const errorMessage = ref<string | null>(null);

// The COMPANY logo shown ON DOCUMENTS (invoices/PDFs). Distinct from the app
// branding logo. It lives in the DOCUMENTS settings group, not the business
// group — so it is loaded/saved via a SEPARATE GET/PATCH /v1/settings/documents
// (partial PATCH of just this field, auto-saved on upload/clear).
const companyLogoFileId = ref<string | null>(null);
const companyLogoSrc = computed<string | null>(() =>
  companyLogoFileId.value ? logoUrlFor(companyLogoFileId.value) : null,
);

const businessName = ref("");
const legalName = ref<string | null>(null);
const vatNumber = ref<string | null>(null);
const taxCode = ref<string | null>(null);
const email = ref<string | null>(null);
const phone = ref<string | null>(null);
const website = ref<string | null>(null);

// Address as structured sub-fields.
const addrLine1 = ref("");
const addrLine2 = ref("");
const addrCity = ref("");
const addrRegion = ref("");
const addrPostalCode = ref("");
const addrCountry = ref("");

/** Fill every address field from an autocomplete-resolved address. */
const fillAddress = (a: ResolvedAddress): void => {
  addrLine1.value = a.line1;
  if (a.city) addrCity.value = a.city;
  if (a.region) addrRegion.value = a.region;
  if (a.postalCode) addrPostalCode.value = a.postalCode;
  if (a.country) addrCountry.value = a.country;
};

const bankAccounts = ref<BankAccount[]>([]);

const load = async (): Promise<void> => {
  loading.value = true;
  errorMessage.value = null;
  try {
    // Business settings + the document-logo (a separate settings group).
    const [s, docs] = await Promise.all([
      api.get<BusinessSettings>("/v1/settings/business"),
      api.get<DocumentSettings>("/v1/settings/documents").catch(() => null),
    ]);
    companyLogoFileId.value = docs?.companyLogoFileId ?? null;
    businessName.value = s.businessName ?? "";
    legalName.value = s.legalName;
    vatNumber.value = s.vatNumber;
    taxCode.value = s.taxCode;
    email.value = s.email;
    phone.value = s.phone;
    website.value = s.website;
    addrLine1.value = s.address?.line1 ?? "";
    addrLine2.value = s.address?.line2 ?? "";
    addrCity.value = s.address?.city ?? "";
    addrRegion.value = s.address?.region ?? "";
    addrPostalCode.value = s.address?.postalCode ?? "";
    addrCountry.value = s.address?.country ?? "";
    bankAccounts.value = s.bankAccounts ?? [];
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.company.loadError")} (${err.code})` : t("settings.company.loadError");
  } finally {
    loading.value = false;
  }
};

const buildAddress = (): Address | null => {
  const line1 = addrLine1.value.trim();
  const city = addrCity.value.trim();
  const postalCode = addrPostalCode.value.trim();
  const country = addrCountry.value.trim();
  const line2 = addrLine2.value.trim();
  const region = addrRegion.value.trim();
  if (!line1 && !city && !postalCode && !country) return null;
  const address: Address = { line1, city, postalCode, country };
  if (line2) address.line2 = line2;
  if (region) address.region = region;
  return address;
};

const save = async (): Promise<void> => {
  clear();
  errorMessage.value = null;
  saving.value = true;
  const payload: BusinessSettings = {
    businessName: businessName.value,
    legalName: legalName.value,
    vatNumber: vatNumber.value,
    taxCode: taxCode.value,
    address: buildAddress(),
    email: email.value,
    phone: phone.value,
    website: website.value,
    bankAccounts: bankAccounts.value,
  };
  try {
    await api.patch<BusinessSettings>("/v1/settings/business", payload);
    notify(t("settings.company.saved"));
  } catch (err) {
    applyError(err);
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.company.saveError")} (${err.code})` : t("settings.company.saveError");
  } finally {
    saving.value = false;
  }
};

/**
 * Persist just the document logo. PATCH /v1/settings/documents is partial, so
 * sending only `companyLogoFileId` leaves the other documents-settings fields
 * (numbering, layout, header/footer) untouched.
 */
const saveCompanyLogo = async (value: string | null): Promise<void> => {
  const payload: DocumentDesignSettings = { companyLogoFileId: value };
  try {
    await api.patch<DocumentSettings>("/v1/settings/documents", payload);
    companyLogoFileId.value = value;
    notify(t("settings.company.saved"));
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.company.saveError")} (${err.code})` : t("settings.company.saveError");
  }
};

const onCompanyLogoSelected = async (files: File | File[]): Promise<void> => {
  const file = Array.isArray(files) ? files[0] : files;
  if (!file) return;
  uploading.value = true;
  errorMessage.value = null;
  try {
    const fileId = await uploadFile(file);
    await saveCompanyLogo(fileId);
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.company.saveError")} (${err.code})` : t("settings.company.saveError");
  } finally {
    uploading.value = false;
  }
};

const clearCompanyLogo = async (): Promise<void> => {
  errorMessage.value = null;
  await saveCompanyLogo(null);
};

onMounted(() => {
  void load();
});
</script>

<template>
  <v-card variant="outlined" rounded="lg">
    <v-card-text>
    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
    </v-alert>

    <div v-if="loading" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </div>

    <v-form v-else @submit.prevent="save">
      <v-row>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="businessName"
            :label="t('settings.company.businessName')"
            :error-messages="fieldErrors.businessName"
            density="comfortable"
            required
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="legalName"
            :label="t('settings.company.legalName')"
            :error-messages="fieldErrors.legalName"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="vatNumber"
            :label="t('settings.company.vatNumber')"
            :error-messages="fieldErrors.vatNumber"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="taxCode"
            :label="t('settings.company.taxCode')"
            :error-messages="fieldErrors.taxCode"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="email"
            :label="t('settings.company.email')"
            :error-messages="fieldErrors.email"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="phone"
            :label="t('settings.company.phone')"
            :error-messages="fieldErrors.phone"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="website"
            :label="t('settings.company.website')"
            :error-messages="fieldErrors.website"
            density="comfortable"
          />
        </v-col>
      </v-row>

      <v-divider class="my-4" />
      <div class="mb-3">
        <div class="text-subtitle-2 font-weight-medium">{{ t("settings.documents.companyLogo") }}</div>
        <div class="text-caption text-medium-emphasis">{{ t("settings.documents.companyLogoHint") }}</div>
      </div>
      <v-row>
        <v-col cols="12" md="6">
          <v-file-input
            :label="t('settings.documents.companyLogo')"
            accept="image/*"
            prepend-icon="mdi-image-outline"
            :loading="uploading"
            density="comfortable"
            hide-details
            @update:model-value="onCompanyLogoSelected"
          />
        </v-col>
        <v-col cols="12" md="6" class="d-flex align-center" style="gap: 12px">
          <v-sheet
            v-if="companyLogoSrc"
            border
            rounded="lg"
            class="pa-2 d-inline-flex align-center justify-center"
            color="surface"
          >
            <v-img
              :src="companyLogoSrc"
              max-height="56"
              max-width="200"
              :alt="t('settings.documents.companyLogoPreview')"
            />
          </v-sheet>
          <v-btn
            v-if="companyLogoSrc"
            variant="text"
            color="error"
            prepend-icon="mdi-close"
            :disabled="uploading"
            @click="clearCompanyLogo"
          >
            {{ t("settings.bankAccounts.remove") }}
          </v-btn>
        </v-col>
      </v-row>

      <v-divider class="my-4" />
      <div class="mb-3">
        <div class="text-subtitle-2 font-weight-medium">{{ t("settings.company.address.title") }}</div>
        <div class="text-caption text-medium-emphasis">{{ t("settings.company.address.hint") }}</div>
      </div>
      <v-row>
        <v-col cols="12" md="6">
          <AddressAutocomplete
            v-model="addrLine1"
            :label="t('settings.company.address.line1')"
            :error-messages="fieldErrors['address.line1']"
            @resolved="fillAddress"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="addrLine2"
            :label="t('settings.company.address.line2')"
            :error-messages="fieldErrors['address.line2']"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="addrCity"
            :label="t('settings.company.address.city')"
            :error-messages="fieldErrors['address.city']"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="addrRegion"
            :label="t('settings.company.address.region')"
            :error-messages="fieldErrors['address.region']"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="addrPostalCode"
            :label="t('settings.company.address.postalCode')"
            :error-messages="fieldErrors['address.postalCode']"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="4">
          <CountrySelect
            v-model="addrCountry"
            :label="t('settings.company.address.country')"
            :error-messages="fieldErrors['address.country']"
            clearable
          />
        </v-col>
      </v-row>

      <v-divider class="my-4" />
      <div class="mb-3">
        <div class="text-subtitle-2 font-weight-medium">{{ t("settings.bankAccounts.title") }}</div>
        <div class="text-caption text-medium-emphasis">{{ t("settings.bankAccounts.hint") }}</div>
      </div>
      <BankAccountsEditor v-model="bankAccounts" />

      <div class="d-flex mt-4" style="gap: 12px">
        <v-spacer />
        <v-btn color="primary" type="submit" :loading="saving">{{ t("settings.company.save") }}</v-btn>
      </div>
    </v-form>
    </v-card-text>
  </v-card>
</template>
