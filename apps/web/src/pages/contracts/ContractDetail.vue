<script setup lang="ts">
/**
 * Contract detail — the read view for a single contract. Contracts previously
 * had no detail page (the list row-click went straight to edit), so Preview /
 * Print / Download were only reachable from the row menu. This page gives
 * contracts the same DocumentActions surface invoices have, plus a "Send" action
 * (SendDocumentModal, documentType="contract"). Any non-deleted contract is
 * sendable per the backend gate.
 */
import { ref, computed, watch, onMounted } from "vue";
import { useClientNames } from "@/composables/useClientNames";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import { apiErrorReason } from "@/utils/validationMessages";
import type { Contract } from "@/types/domain";
import { minorToDisplay } from "@/utils/money";
import { enumLabel } from "@/utils/enums";
import StatusChip from "@/components/StatusChip.vue";
import AppCard from "@/components/AppCard.vue";
import DocumentActions from "@/components/DocumentActions.vue";
import SendDocumentModal from "@/components/SendDocumentModal.vue";
import PageHeader from "@/components/PageHeader.vue";
import { useIsMobile } from "@/composables/useIsMobile";

const route = useRoute();
const isMobile = useIsMobile();
const { t } = useI18n();
const id = computed<string>(() => route.params.id as string);

const contract = ref<Contract | null>(null);
const { resolve: resolveClientNames, nameOf: clientNameOf } = useClientNames();
// Resolve the client display name once the document is loaded.
watch(contract, (v) => {
  if (v?.clientId) void resolveClientNames([v.clientId]);
});
const loading = ref(false);
const errorMessage = ref<string | null>(null);
const sendModal = ref(false);

const load = async (): Promise<void> => {
  loading.value = true;
  errorMessage.value = null;
  try {
    contract.value = await api.get<Contract>(`/v1/contracts/${id.value}`);
  } catch (err) {
    contract.value = null;
    errorMessage.value =
      err instanceof ApiError
        ? t("contracts.loadOneError", { code: apiErrorReason(err) })
        : t("contracts.loadOneErrorGeneric");
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  void load();
});
</script>

<template>
  <div>
    <PageHeader :title="t('contracts.detailTitle')" back>
      <!-- Phone: Edit sits on the title row. -->
      <template #mobile-actions>
        <v-btn
          v-if="contract"
          icon="mdi-pencil"
          variant="text"
          :aria-label="t('common.edit')"
          :to="{ name: 'contract-edit', params: { id: contract.id } }"
        />
      </template>
    </PageHeader>

    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
      <template #append>
        <v-btn color="primary" size="small" @click="load">{{ t("common.retry") }}</v-btn>
      </template>
    </v-alert>

    <v-card v-if="loading" variant="outlined" rounded="lg" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </v-card>

    <template v-else-if="contract">
      <!-- Phone: hero summary card + text sections. Desktop markup below is untouched. -->
      <template v-if="isMobile">
        <section class="dm-card dm-hero">
          <div class="dm-hero__head">
            <div class="dm-hero__title">{{ contract.title }}</div>
            <StatusChip :status="contract.status" />
          </div>
          <div class="dm-hero__client">{{ clientNameOf(contract.clientId) ?? "\u2014" }}</div>

          <div class="dm-hero__amount">
            <div class="dm-label">{{ t("contracts.fields.value") }}</div>
            <div class="dm-hero__total">{{ minorToDisplay(contract.valueMinor, contract.currency ?? "EUR") }}</div>
          </div>

          <div class="dm-meta">
            <div>
              <div class="dm-label">{{ t("contracts.fields.type") }}</div>
              <div class="dm-meta__value">{{ enumLabel(t, "contractType", contract.type) }}</div>
            </div>
            <div>
              <div class="dm-label">{{ t("contracts.fields.currency") }}</div>
              <div class="dm-meta__value">{{ contract.currency ?? "\u2014" }}</div>
            </div>
            <div>
              <div class="dm-label">{{ t("contracts.fields.startDate") }}</div>
              <div class="dm-meta__value">{{ contract.startDate || "\u2014" }}</div>
            </div>
            <div>
              <div class="dm-label">{{ t("contracts.fields.endDate") }}</div>
              <div class="dm-meta__value">{{ contract.endDate ?? "\u2014" }}</div>
            </div>
          </div>
        </section>

        <div class="dm-actions">
          <div class="dm-actions__primary">
            <v-btn color="primary" variant="flat" prepend-icon="mdi-email-outline" @click="sendModal = true">
              {{ t("contracts.send") }}
            </v-btn>
          </div>
          <DocumentActions document-type="contract" :document-id="contract.id" />
        </div>

        <section v-if="contract.terms" class="dm-card">
          <div class="dm-label mb-1">{{ t("contracts.fields.terms") }}</div>
          <div class="dm-text">{{ contract.terms }}</div>
        </section>

        <section v-if="contract.notes" class="dm-card">
          <div class="dm-label mb-1">{{ t("contracts.fields.notes") }}</div>
          <div class="dm-text">{{ contract.notes }}</div>
        </section>
      </template>

      <template v-else>
      <AppCard>
        <template #header>
          <div class="text-h6 mr-3">{{ contract.title }}</div>
          <StatusChip :status="contract.status" />
        </template>

        <v-row>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("invoices.fields.client") }}</div>{{ clientNameOf(contract.clientId) ?? "\u2014" }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("contracts.fields.type") }}</div>{{ enumLabel(t, "contractType", contract.type) }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("contracts.fields.startDate") }}</div>{{ contract.startDate }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("contracts.fields.endDate") }}</div>{{ contract.endDate ?? "—" }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("contracts.fields.value") }}</div>{{ minorToDisplay(contract.valueMinor, contract.currency ?? "EUR") }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("contracts.fields.currency") }}</div>{{ contract.currency ?? "—" }}</v-col>
        </v-row>

        <template #actions>
          <div class="d-flex align-center" style="gap: 8px; flex-wrap: wrap; width: 100%">
            <DocumentActions document-type="contract" :document-id="contract.id" />
            <v-spacer />
            <v-btn
              color="primary"
              prepend-icon="mdi-email-outline"
              @click="sendModal = true"
            >
              {{ t("contracts.send") }}
            </v-btn>
            <v-btn
              color="primary"
              prepend-icon="mdi-pencil"
              :to="{ name: 'contract-edit', params: { id: contract.id } }"
            >
              {{ t("common.edit") }}
            </v-btn>
          </div>
        </template>
      </AppCard>

      <v-card v-if="contract.terms" variant="outlined" rounded="lg" class="mb-4">
        <v-card-text>
        <div class="text-subtitle-2 mb-2">{{ t("contracts.fields.terms") }}</div>
        <div class="text-body-2" style="white-space: pre-wrap">{{ contract.terms }}</div>
        </v-card-text>
      </v-card>

      <v-card v-if="contract.notes" variant="outlined" rounded="lg">
        <v-card-text>
        <div class="text-subtitle-2 mb-2">{{ t("contracts.fields.notes") }}</div>
        <div class="text-body-2" style="white-space: pre-wrap">{{ contract.notes }}</div>
        </v-card-text>
      </v-card>
      </template>

      <SendDocumentModal
        v-model="sendModal"
        document-type="contract"
        :document-id="contract.id"
        kind="invoice"
        :version="contract.version"
      />
    </template>
  </div>
</template>

<style scoped>
/* ── Phone detail layout (isMobile branch only) ───────────────────────── */
.dm-card {
  background: rgb(var(--v-theme-surface));
  border: 1px solid var(--v-billy-border, rgba(0, 0, 0, 0.12));
  border-radius: 16px;
  padding: 16px;
  margin-bottom: 12px;
}
.dm-label {
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.4;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.55));
}
.dm-hero__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.dm-hero__title {
  min-width: 0;
  font-size: 1.125rem;
  font-weight: 700;
  line-height: 1.35;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}
.dm-hero__client {
  margin-top: 2px;
  font-size: 0.9375rem;
  line-height: 1.4;
  color: var(--v-billy-text-2, rgba(var(--v-theme-on-surface), 0.7));
  overflow-wrap: anywhere;
}
.dm-hero__amount {
  margin-top: 16px;
}
.dm-hero__total {
  font-size: 1.875rem;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.dm-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--v-billy-border, rgba(0, 0, 0, 0.12));
}
.dm-meta__value {
  margin-top: 2px;
  font-size: 0.9375rem;
  line-height: 1.35;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
/* Lifecycle actions under the hero: primary row, then Preview/Print/Download. */
.dm-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}
.dm-actions__primary {
  display: flex;
  gap: 8px;
}
.dm-actions__primary > .v-btn {
  flex: 1 1 0;
  min-width: 0;
  height: 48px !important;
  border-radius: 14px;
}
.dm-text {
  font-size: 0.9375rem;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
