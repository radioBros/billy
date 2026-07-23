<script setup lang="ts">
/**
 * Credit note detail — shows the document + line items and the guarded lifecycle
 * actions (credit-notes routes): issue (draft → issued, assigns CN- number) and
 * void (→ terminal). Both send the optimistic-concurrency `version` via If-Match
 * (the routes require it), mirroring InvoiceDetail's finalize/void.
 */
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import type { CreditNote } from "@/types/domain";
import { minorToDisplay } from "@/utils/money";
import StatusChip from "@/components/StatusChip.vue";
import AppCard from "@/components/AppCard.vue";
import DocumentActions from "@/components/DocumentActions.vue";
import { confirm } from "@/composables/useConfirm";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const id = computed<string>(() => route.params.id as string);

const creditNote = ref<CreditNote | null>(null);
const loading = ref(false);
const errorMessage = ref<string | null>(null);
const actionError = ref<string | null>(null);
const acting = ref(false);

const isDraft = computed<boolean>(() => creditNote.value?.status === "draft");
const canVoid = computed<boolean>(
  () => creditNote.value != null && creditNote.value.status !== "void",
);

const load = async (): Promise<void> => {
  loading.value = true;
  errorMessage.value = null;
  try {
    creditNote.value = await api.get<CreditNote>(`/v1/credit-notes/${id.value}`);
  } catch (err) {
    creditNote.value = null;
    errorMessage.value =
      err instanceof ApiError ? t("creditNotes.loadError", { code: err.code }) : t("creditNotes.loadErrorGeneric");
  } finally {
    loading.value = false;
  }
};

const runAction = async (fn: () => Promise<CreditNote>): Promise<void> => {
  actionError.value = null;
  acting.value = true;
  try {
    creditNote.value = await fn();
  } catch (err) {
    actionError.value = err instanceof ApiError ? t("common.actionFailed", { code: err.code }) : t("common.actionFailedGeneric");
  } finally {
    acting.value = false;
  }
};

const issue = async (): Promise<void> => {
  if (!creditNote.value) return;
  const ok = await confirm({
    title: t("creditNotes.confirm.issueTitle"),
    message: t("creditNotes.confirm.issueMessage"),
    confirmText: t("creditNotes.issue"),
  });
  if (!ok) return;
  await runAction(() =>
    api.post<CreditNote>(`/v1/credit-notes/${id.value}/issue`, undefined, { ifMatch: creditNote.value!.version }),
  );
};
const voidNote = async (): Promise<void> => {
  if (!creditNote.value) return;
  const ok = await confirm({
    title: t("creditNotes.confirm.voidTitle"),
    message: t("creditNotes.confirm.voidMessage"),
    confirmText: t("creditNotes.void"),
    tone: "error",
  });
  if (!ok) return;
  await runAction(() =>
    api.post<CreditNote>(`/v1/credit-notes/${id.value}/void`, undefined, { ifMatch: creditNote.value!.version }),
  );
};

onMounted(() => {
  void load();
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 12px">
      <v-btn icon="mdi-arrow-left" variant="text" :aria-label="t('common.back')" @click="router.back()" />
      <h1 class="text-h5">{{ t("creditNotes.detailTitle") }}</h1>
    </div>

    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
      <template #append>
        <v-btn variant="text" size="small" @click="load">{{ t("creditNotes.retry") }}</v-btn>
      </template>
    </v-alert>

    <v-card v-if="loading" variant="outlined" rounded="lg" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </v-card>

    <template v-else-if="creditNote">
      <v-alert v-if="actionError" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
        {{ actionError }}
      </v-alert>

      <AppCard>
        <template #header>
          <div class="text-h6 mr-3">{{ creditNote.creditNoteNumber ?? t("creditNotes.draftUnnumbered") }}</div>
          <StatusChip :status="creditNote.status" />
        </template>

        <v-row>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("creditNotes.fields.client") }}</div>{{ creditNote.clientId }}</v-col>
          <v-col cols="6" md="3">
            <div class="text-caption">{{ t("creditNotes.fields.creditedInvoice") }}</div>
            {{ creditNote.creditedInvoiceNumber ?? creditNote.creditedInvoiceId }}
          </v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("creditNotes.fields.currency") }}</div>{{ creditNote.currency }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("creditNotes.fields.issueDate") }}</div>{{ creditNote.issueDate }}</v-col>
          <v-col v-if="creditNote.reason" cols="12"><div class="text-caption">{{ t("creditNotes.fields.reason") }}</div>{{ creditNote.reason }}</v-col>
        </v-row>

        <template #actions>
          <div class="d-flex align-center" style="gap: 8px; flex-wrap: wrap; width: 100%">
            <DocumentActions document-type="credit-note" :document-id="creditNote.id" />
            <v-spacer />
            <v-btn
              v-if="isDraft"
              variant="text"
              prepend-icon="mdi-pencil"
              :to="{ name: 'credit-note-edit', params: { id: creditNote.id } }"
            >
              {{ t("common.edit") }}
            </v-btn>
            <v-btn v-if="isDraft" color="primary" :loading="acting" @click="issue">{{ t("creditNotes.issue") }}</v-btn>
            <v-btn v-if="canVoid" color="error" variant="outlined" :loading="acting" @click="voidNote">
              {{ t("creditNotes.void") }}
            </v-btn>
          </div>
        </template>
      </AppCard>

      <v-card variant="outlined" rounded="lg">
        <v-card-text>
        <div class="text-subtitle-2 mb-2">{{ t("creditNotes.lineItems") }}</div>
        <v-table density="compact">
          <thead>
            <tr>
              <th>{{ t("creditNotes.lineCols.description") }}</th>
              <th class="text-right">{{ t("creditNotes.lineCols.qty") }}</th>
              <th class="text-right">{{ t("creditNotes.lineCols.unit") }}</th>
              <th class="text-right">{{ t("creditNotes.lineCols.total") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(li, i) in creditNote.lineItems" :key="i">
              <td>{{ li.description }}</td>
              <td class="text-right">{{ li.quantity }}</td>
              <td class="text-right">{{ minorToDisplay(li.unitPriceMinor, creditNote.currency) }}</td>
              <td class="text-right">{{ minorToDisplay(li.lineTotalMinor, creditNote.currency) }}</td>
            </tr>
          </tbody>
        </v-table>
        <v-divider class="my-3" />
        <div class="d-flex justify-end">
          <div style="min-width: 240px">
            <div class="d-flex justify-space-between">
              <span>{{ t("creditNotes.totals.subtotal") }}</span><span>{{ minorToDisplay(creditNote.subtotalMinor, creditNote.currency) }}</span>
            </div>
            <div class="d-flex justify-space-between">
              <span>{{ t("creditNotes.totals.tax") }}</span><span>{{ minorToDisplay(creditNote.taxMinor, creditNote.currency) }}</span>
            </div>
            <div class="d-flex justify-space-between text-subtitle-1 font-weight-medium">
              <span>{{ t("creditNotes.totals.total") }}</span><span>{{ minorToDisplay(creditNote.grandTotalMinor, creditNote.currency) }}</span>
            </div>
          </div>
        </div>
        </v-card-text>
      </v-card>
    </template>
  </div>
</template>
