<script setup lang="ts">
/**
 * Contract detail — the read view for a single contract. Contracts previously
 * had no detail page (the list row-click went straight to edit), so Preview /
 * Print / Download were only reachable from the row menu. This page gives
 * contracts the same DocumentActions surface invoices have, plus a "Send" action
 * (SendDocumentModal, documentType="contract"). Any non-deleted contract is
 * sendable per the backend gate.
 */
import { ref, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import type { Contract } from "@/types/domain";
import { minorToDisplay } from "@/utils/money";
import { enumLabel } from "@/utils/enums";
import StatusChip from "@/components/StatusChip.vue";
import AppCard from "@/components/AppCard.vue";
import DocumentActions from "@/components/DocumentActions.vue";
import SendDocumentModal from "@/components/SendDocumentModal.vue";

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const id = computed<string>(() => route.params.id as string);

const contract = ref<Contract | null>(null);
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
        ? t("contracts.loadOneError", { code: err.code })
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
    <div class="d-flex align-center mb-4" style="gap: 12px">
      <v-btn icon="mdi-arrow-left" variant="text" :aria-label="t('common.back')" @click="router.back()" />
      <h1 class="text-h5">{{ t("contracts.detailTitle") }}</h1>
    </div>

    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
      <template #append>
        <v-btn variant="text" size="small" @click="load">{{ t("common.retry") }}</v-btn>
      </template>
    </v-alert>

    <v-card v-if="loading" variant="outlined" rounded="lg" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </v-card>

    <template v-else-if="contract">
      <AppCard>
        <template #header>
          <div class="text-h6 mr-3">{{ contract.title }}</div>
          <StatusChip :status="contract.status" />
        </template>

        <v-row>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("contracts.fields.clientId") }}</div>{{ contract.clientId }}</v-col>
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
              variant="outlined"
              prepend-icon="mdi-email-outline"
              @click="sendModal = true"
            >
              {{ t("contracts.send") }}
            </v-btn>
            <v-btn
              variant="text"
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
