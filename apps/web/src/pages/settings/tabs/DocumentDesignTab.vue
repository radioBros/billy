<script setup lang="ts">
/**
 * Document Design tab — configures how invoices/quotes/PDFs look, with a live,
 * full-width preview that mirrors the server's PDF layout.
 *
 * This tab straddles TWO settings groups and loads/patches BOTH on save:
 *   • branding  (GET/PATCH /v1/settings/branding) — owns `documentHeaderHtml` /
 *     `documentFooterHtml`. The rest of the branding payload is round-tripped
 *     untouched so a save here never wipes the identity/color fields the
 *     Branding tab owns (both tabs PATCH the shared group — last-save-wins).
 *   • documents (GET/PATCH /v1/settings/documents) — owns `logoPosition` and
 *     `showBankDetails` (the document-design fields). Only that subset is
 *     PATCHed, so the numbering fields the Documents tab owns are left intact.
 *     (The company logo shown on documents, `companyLogoFileId`, is edited in
 *     the Company tab, not here.)
 *
 * Company identity (name/address/VAT/email/bank) is read from
 * /v1/settings/business so the preview reflects the real company. The preview is
 * an APPROXIMATION driven from the SAME fields the PDF uses so it mirrors, not
 * diverges: company logo on one side, company details + INVOICE heading on the
 * other, recipient opposite the logo, line items, totals (grand total large),
 * an optional bank block, then the footer HTML.
 */
import { ref, computed, onMounted, inject } from "vue";
import { useI18n } from "vue-i18n";
import { useTheme } from "vuetify";
import { api, ApiError } from "@/api/client";
import type {
  BrandingSettings,
  BusinessSettings,
  DocumentSettings,
  DocumentDesignSettings,
} from "@/types/domain";
import { useBrandingStore, toApplied } from "@/stores/branding";
import { SNACKBAR_KEY, NOOP_NOTIFY } from "@/pages/settings/snackbar";
import { sanitizeHtml } from "@/pages/settings/sanitizeHtml";
import SettingsSection from "@/pages/settings/SettingsSection.vue";
import LocalizedTextEditor from "@/components/LocalizedTextEditor.vue";
import { DEFAULT_LOCALE } from "@billy/shared/locales";
import { toLocalizedMap, resolveLocalized } from "@billy/shared/localized-text";

const { t } = useI18n();
const theme = useTheme();
const branding = useBrandingStore();
const notify = inject(SNACKBAR_KEY, NOOP_NOTIFY);

const loading = ref(false);
const saving = ref(false);
const errorMessage = ref<string | null>(null);

// ── Branding group (header/footer HTML). Held as per-locale maps for the
// LocalizedTextEditor; loaded via toLocalizedMap and coerced back to null on
// save when the map is empty (preserves "cleared" semantics).
const documentHeaderHtml = ref<Record<string, string>>({});
const documentFooterHtml = ref<Record<string, string>>({});
// The rest of the branding payload, round-tripped untouched on save.
const brandingRest = ref<Omit<BrandingSettings, "documentHeaderHtml" | "documentFooterHtml"> | null>(null);

// ── Documents group (document-design fields — persisted).
type LogoPosition = "left" | "right";
const logoPosition = ref<LogoPosition>("left");
const showBankDetails = ref(true);

// ── Business group (read for a realistic preview).
const business = ref<BusinessSettings | null>(null);

// Brand colors drive the preview accents (same source the shell/PDF use).
const previewPrimary = computed(() => branding.primaryColor);
const previewAccent = computed(() => branding.accentColor);

// Company identity, derived from the business settings (sample fallbacks keep the
// preview meaningful before the company details are filled in).
const companyName = computed(
  () => business.value?.businessName || business.value?.legalName || t("settings.documents.sampleCompanyName"),
);
const companyAddressLines = computed<string[]>(() => {
  const addr = business.value?.address;
  if (!addr) {
    return t("settings.documents.sampleAddress")
      .split(/\r?\n/u)
      .map((l: string) => l.trim())
      .filter(Boolean);
  }
  const cityLine = [addr.postalCode, addr.city].filter(Boolean).join(" ") + (addr.region ? ` (${addr.region})` : "");
  return [addr.line1, addr.line2 ?? "", cityLine.trim(), addr.country]
    .map((l) => (l ?? "").trim())
    .filter(Boolean);
});
const companyVat = computed(() => business.value?.vatNumber || null);
const companyReg = computed(() => business.value?.taxCode || null);

// Bank lines for the preview block (first configured bank account's details).
const bankLines = computed<{ label: string; value: string }[]>(() => {
  const out: { label: string; value: string }[] = [];
  const first = business.value?.bankAccounts?.[0];
  if (first?.details) out.push({ label: first.label || t("settings.documents.bankAccount"), value: first.details });
  return out;
});
const showBankBlock = computed(() => showBankDetails.value && bankLines.value.length > 0);

// logoPosition=right INVERTS the header columns and moves the recipient opposite
// the logo. `logoOnLeft` is the single source of truth the template reads.
const logoOnLeft = computed(() => logoPosition.value === "left");

// Preview resolves each map to a single language (default locale, with the
// tolerant fallback chain) then sanitizes — the two editors each own their own
// language dropdown, so the preview can't track "the shown language" precisely.
const safeHeader = computed(() => sanitizeHtml(resolveLocalized(documentHeaderHtml.value, DEFAULT_LOCALE)));
const safeFooter = computed(() => sanitizeHtml(resolveLocalized(documentFooterHtml.value, DEFAULT_LOCALE)));

/** A localized-text map ready for the API: send null when it has no content. */
const mapOrNull = (map: Record<string, string>): Record<string, string> | null => {
  const kept = Object.fromEntries(Object.entries(map).filter(([, v]) => v.trim().length > 0));
  return Object.keys(kept).length > 0 ? kept : null;
};

const invoiceHeading = computed(() =>
  t("settings.documents.invoiceHeading", { number: "INV-0001", date: "2026-07-15" }),
);

const load = async (): Promise<void> => {
  loading.value = true;
  errorMessage.value = null;
  try {
    const [b, docs, biz] = await Promise.all([
      api.get<BrandingSettings>("/v1/settings/branding"),
      api.get<DocumentSettings>("/v1/settings/documents"),
      api.get<BusinessSettings>("/v1/settings/business").catch(() => null),
    ]);

    documentHeaderHtml.value = toLocalizedMap(b.documentHeaderHtml);
    documentFooterHtml.value = toLocalizedMap(b.documentFooterHtml);
    const { documentHeaderHtml: _h, documentFooterHtml: _f, ...others } = b;
    brandingRest.value = others;
    // Ensure the store reflects current branding so the preview colors mirror the PDF.
    branding.apply(theme, toApplied(b));

    logoPosition.value = docs.logoPosition ?? "left";
    showBankDetails.value = docs.showBankDetails ?? true;

    business.value = biz;
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.documents.loadError")} (${err.code})` : t("settings.documents.loadError");
  } finally {
    loading.value = false;
  }
};

const save = async (): Promise<void> => {
  if (!brandingRest.value) return;
  errorMessage.value = null;
  saving.value = true;

  const brandingPayload: BrandingSettings = {
    ...brandingRest.value,
    documentHeaderHtml: mapOrNull(documentHeaderHtml.value),
    documentFooterHtml: mapOrNull(documentFooterHtml.value),
  };
  const documentsPayload: DocumentDesignSettings = {
    logoPosition: logoPosition.value,
    showBankDetails: showBankDetails.value,
  };

  try {
    const [savedBranding] = await Promise.all([
      api.patch<BrandingSettings>("/v1/settings/branding", brandingPayload),
      api.patch<DocumentSettings>("/v1/settings/documents", documentsPayload),
    ]);
    branding.apply(theme, toApplied(savedBranding));
    notify(t("settings.documents.saved"));
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError ? `${t("settings.documents.saveError")} (${err.code})` : t("settings.documents.saveError");
  } finally {
    saving.value = false;
  }
};

onMounted(() => {
  void load();
});
</script>

<template>
  <!-- Full-width: no md split. Controls stack above a full-width PDF preview. -->
  <v-card variant="outlined" rounded="lg">
    <v-card-text>
    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
    </v-alert>

    <div v-if="loading" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </div>

    <v-form v-else @submit.prevent="save">
      <!-- Controls -->
      <SettingsSection first :title="t('settings.documents.controls')">
        <LocalizedTextEditor
          v-model="documentHeaderHtml"
          :label="t('settings.documents.headerHtml')"
          mode="rich"
          class="mb-1"
        />
        <div class="text-caption text-medium-emphasis mb-4">{{ t("settings.documents.headerHint") }}</div>

        <LocalizedTextEditor
          v-model="documentFooterHtml"
          :label="t('settings.documents.footerHtml')"
          mode="rich"
          class="mb-1"
        />
        <div class="text-caption text-medium-emphasis">{{ t("settings.documents.footerHint") }}</div>
      </SettingsSection>

      <SettingsSection :title="t('settings.documents.layout')">
        <v-row dense>
          <v-col cols="12" md="6">
            <div class="text-caption text-medium-emphasis mb-1">{{ t("settings.documents.logoPosition") }}</div>
            <v-btn-toggle
              v-model="logoPosition"
              mandatory
              divided
              variant="outlined"
              density="comfortable"
              color="primary"
            >
              <v-btn value="left" prepend-icon="mdi-format-horizontal-align-left">
                {{ t("settings.documents.logoLeft") }}
              </v-btn>
              <v-btn value="right" prepend-icon="mdi-format-horizontal-align-right">
                {{ t("settings.documents.logoRight") }}
              </v-btn>
            </v-btn-toggle>
            <div class="text-caption text-medium-emphasis mt-1">{{ t("settings.documents.logoPositionHint") }}</div>
          </v-col>

          <v-col cols="12">
            <v-switch
              v-model="showBankDetails"
              :label="t('settings.documents.showBankDetails')"
              color="primary"
              density="comfortable"
              hide-details
            />
            <div class="text-caption text-medium-emphasis">{{ t("settings.documents.showBankDetailsHint") }}</div>
          </v-col>
        </v-row>
      </SettingsSection>

      <!-- Full-width live preview -->
      <SettingsSection :title="t('settings.documents.preview')" :hint="t('settings.documents.previewHint')">
        <v-sheet border rounded="lg" color="white" class="doc-preview pa-8" theme="light">
          <!-- Header band: logo one side, company identity + heading the other. -->
          <div class="doc-preview__header" :class="{ 'doc-preview__header--rev': !logoOnLeft }">
            <!-- Logo side. No logo → the slot stays EMPTY (the company name already
                 shows in the identity block; repeating it here is redundant). -->
            <div class="doc-preview__logo" :style="{ textAlign: logoOnLeft ? 'left' : 'right' }" />

            <!-- Company details side (aligned toward the recipient/opposite the logo) -->
            <div class="doc-preview__company" :style="{ textAlign: logoOnLeft ? 'right' : 'left' }">
              <div class="font-weight-bold">{{ companyName }}</div>
              <div v-for="(line, i) in companyAddressLines" :key="i" class="text-body-2">{{ line }}</div>
              <div v-if="companyVat || companyReg" class="text-body-2">
                <template v-if="companyVat">Vat Id {{ companyVat }}</template>
                <template v-if="companyVat && companyReg"> - </template>
                <template v-if="companyReg">C.F. {{ companyReg }}</template>
              </div>
              <div class="doc-preview__heading mt-2 font-weight-bold" :style="{ color: previewPrimary }">
                {{ invoiceHeading }}
              </div>
            </div>
          </div>

          <v-divider class="my-4" />

          <!-- Admin header HTML (sanitized) -->
          <div v-if="safeHeader" class="doc-preview__html text-body-2 mb-4" v-html="safeHeader" />

          <!-- Second band: sender secondary block vs. recipient (recipient opposite the logo). -->
          <div class="doc-preview__header" :class="{ 'doc-preview__header--rev': !logoOnLeft }">
            <div :style="{ textAlign: logoOnLeft ? 'left' : 'right' }">
              <div v-if="companyVat" class="text-caption">
                <span class="font-weight-bold">VAT ID</span> {{ companyVat }}
              </div>
              <div v-if="brandingRest?.supportEmail" class="text-caption">
                <span class="font-weight-bold">EMAIL</span> {{ brandingRest.supportEmail }}
              </div>
            </div>
            <div class="doc-preview__recipient" :style="{ textAlign: logoOnLeft ? 'right' : 'left' }">
              <div class="text-caption text-uppercase text-medium-emphasis">{{ t("settings.documents.recipient") }}</div>
              <div class="text-body-2 font-weight-bold">{{ t("settings.documents.sampleClient") }}</div>
              <div class="text-body-2">{{ t("settings.documents.sampleRecipientAddress") }}</div>
            </div>
          </div>

          <v-divider class="my-4" />

          <!-- Line-items table -->
          <table class="doc-preview__table text-body-2">
            <thead>
              <tr :style="{ borderBottom: `2px solid ${previewAccent}` }">
                <th class="text-left">{{ t("settings.documents.colDescription") }}</th>
                <th class="text-right">{{ t("settings.documents.colQty") }}</th>
                <th class="text-right">{{ t("settings.documents.colPrice") }}</th>
                <th class="text-right">{{ t("settings.documents.colAmount") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{{ t("settings.documents.sampleItem1") }}</td>
                <td class="text-right">2</td>
                <td class="text-right">500.00</td>
                <td class="text-right">1,000.00</td>
              </tr>
              <tr>
                <td>{{ t("settings.documents.sampleItem2") }}</td>
                <td class="text-right">1</td>
                <td class="text-right">750.00</td>
                <td class="text-right">750.00</td>
              </tr>
            </tbody>
          </table>

          <!-- Totals — grand total in a much larger font. -->
          <div class="d-flex flex-column align-end mt-4 text-body-2" style="gap: 4px">
            <div class="d-flex" style="gap: 32px">
              <span class="text-medium-emphasis">{{ t("settings.documents.subtotal") }}</span><span>1,750.00</span>
            </div>
            <div class="d-flex" style="gap: 32px">
              <span class="text-medium-emphasis">{{ t("settings.documents.tax") }}</span><span>350.00</span>
            </div>
            <div class="doc-preview__grand-total d-flex align-baseline font-weight-bold mt-1" style="gap: 32px" :style="{ color: previewPrimary }">
              <span>{{ t("settings.documents.grandTotal") }}</span><span>2,100.00</span>
            </div>
          </div>

          <!-- Bank details block (persisted toggle; only when bank details exist). -->
          <div v-if="showBankBlock" class="doc-preview__bank mt-6 pt-3" :style="{ borderTop: `1px solid ${previewAccent}` }">
            <div class="text-caption text-uppercase font-weight-bold text-medium-emphasis mb-1">
              {{ t("settings.documents.bankTitle") }}
            </div>
            <div v-for="(bl, i) in bankLines" :key="i" class="text-body-2">
              <span class="text-medium-emphasis">{{ bl.label }}:</span> {{ bl.value }}
            </div>
          </div>

          <!-- Admin footer HTML (sanitized) -->
          <div
            v-if="safeFooter"
            class="doc-preview__html text-caption text-medium-emphasis mt-6 pt-3"
            :style="{ borderTop: `1px solid ${previewAccent}` }"
            v-html="safeFooter"
          />
        </v-sheet>
      </SettingsSection>

      <div class="d-flex mt-4" style="gap: 12px">
        <v-spacer />
        <v-btn color="primary" type="submit" :loading="saving">{{ t("settings.documents.save") }}</v-btn>
      </div>
    </v-form>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.doc-preview {
  color: #1a1a1a;
  width: 100%;
}
/* Header/second bands: two equal columns; --rev swaps them for logoPosition=right. */
.doc-preview__header {
  display: flex;
  gap: 32px;
  align-items: flex-start;
}
.doc-preview__header--rev {
  flex-direction: row-reverse;
}
.doc-preview__logo,
.doc-preview__company,
.doc-preview__recipient {
  flex: 1 1 0;
  min-width: 0;
}
.doc-preview__heading {
  font-size: 1.05rem;
}
.doc-preview__grand-total {
  /* GRAND TOTAL — much larger than the 14px rows above, matching the PDF. */
  font-size: 1.75rem;
  line-height: 1.1;
}
.doc-preview__table {
  width: 100%;
  border-collapse: collapse;
}
.doc-preview__table th,
.doc-preview__table td {
  padding: 8px 10px;
}
.doc-preview__table tbody tr {
  border-bottom: 1px solid #e5e5e5;
}
/* Contain admin-set HTML so it can't blow out the preview layout. */
.doc-preview__html {
  overflow-wrap: anywhere;
}
.doc-preview__html :deep(img) {
  max-width: 100%;
}
</style>
