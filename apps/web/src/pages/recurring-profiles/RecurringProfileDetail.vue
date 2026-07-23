<script setup lang="ts">
/**
 * Recurring profile detail — shows the template + line items and the guarded
 * lifecycle actions (recurring-billing routes): pause/resume (active⇄paused),
 * cancel (→terminal), and "Generate now" (POST /:id/generate).
 *
 * All lifecycle transitions send the optimistic-concurrency `version` via
 * If-Match. `generate` is the ONE action that takes NO version (the route does
 * not resolve one) and returns an InvoiceDraftPayload | null — the jobs layer
 * (not yet wired) turns the payload into a real invoice, so there is no invoice
 * id to link to yet: we toast success (or "profile exhausted" on null).
 */
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import type { InvoiceDraftPayload, RecurringProfile } from "@/types/domain";
import { minorToDisplay } from "@/utils/money";
import StatusChip from "@/components/StatusChip.vue";
import AppCard from "@/components/AppCard.vue";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const id = computed<string>(() => route.params.id as string);

const profile = ref<RecurringProfile | null>(null);
const loading = ref(false);
const errorMessage = ref<string | null>(null);
const actionError = ref<string | null>(null);
const acting = ref(false);

const toast = ref(false);
const toastText = ref("");
const toastColor = ref<"success" | "info">("success");

const isActive = computed<boolean>(() => profile.value?.status === "active");
const isPaused = computed<boolean>(() => profile.value?.status === "paused");
const canGenerate = computed<boolean>(() => isActive.value || isPaused.value);
const canCancel = computed<boolean>(() => isActive.value || isPaused.value);

const intervalLabel = (p: RecurringProfile): string => {
  const base = t(`recurring.interval.${p.interval}`);
  return p.intervalCount > 1 ? t("recurring.everyN", { n: p.intervalCount, unit: base }) : base;
};

const load = async (): Promise<void> => {
  loading.value = true;
  errorMessage.value = null;
  try {
    profile.value = await api.get<RecurringProfile>(`/v1/recurring-profiles/${id.value}`);
  } catch (err) {
    profile.value = null;
    errorMessage.value =
      err instanceof ApiError ? t("recurring.loadError", { code: err.code }) : t("recurring.loadErrorGeneric");
  } finally {
    loading.value = false;
  }
};

const runAction = async (fn: () => Promise<RecurringProfile>): Promise<void> => {
  actionError.value = null;
  acting.value = true;
  try {
    profile.value = await fn();
  } catch (err) {
    actionError.value = err instanceof ApiError ? t("common.actionFailed", { code: err.code }) : t("common.actionFailedGeneric");
  } finally {
    acting.value = false;
  }
};

const pause = (): void => {
  if (!profile.value) return;
  void runAction(() =>
    api.post<RecurringProfile>(`/v1/recurring-profiles/${id.value}/pause`, undefined, { ifMatch: profile.value!.version }),
  );
};
const resume = (): void => {
  if (!profile.value) return;
  void runAction(() =>
    api.post<RecurringProfile>(`/v1/recurring-profiles/${id.value}/resume`, undefined, { ifMatch: profile.value!.version }),
  );
};
const cancel = (): void => {
  if (!profile.value) return;
  void runAction(() =>
    api.post<RecurringProfile>(`/v1/recurring-profiles/${id.value}/cancel`, undefined, { ifMatch: profile.value!.version }),
  );
};

// Generate takes NO version; returns a draft payload or null when exhausted.
const generate = async (): Promise<void> => {
  if (!profile.value) return;
  actionError.value = null;
  acting.value = true;
  try {
    const payload = await api.post<InvoiceDraftPayload | null>(`/v1/recurring-profiles/${id.value}/generate`, undefined);
    if (payload) {
      toastText.value = t("recurring.generated");
      toastColor.value = "success";
    } else {
      toastText.value = t("recurring.generateExhausted");
      toastColor.value = "info";
    }
    toast.value = true;
    await load(); // refresh occurrences count / nextRunAt / status
  } catch (err) {
    actionError.value = err instanceof ApiError ? t("common.actionFailed", { code: err.code }) : t("common.actionFailedGeneric");
  } finally {
    acting.value = false;
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
      <h1 class="text-h5">{{ t("recurring.detailTitle") }}</h1>
    </div>

    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
      <template #append>
        <v-btn variant="text" size="small" @click="load">{{ t("recurring.retry") }}</v-btn>
      </template>
    </v-alert>

    <v-card v-if="loading" variant="outlined" rounded="lg" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </v-card>

    <template v-else-if="profile">
      <v-alert v-if="actionError" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
        {{ actionError }}
      </v-alert>

      <AppCard>
        <template #header>
          <div class="text-h6 mr-3">{{ intervalLabel(profile) }}</div>
          <StatusChip :status="profile.status" />
        </template>

        <v-row>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("recurring.fields.client") }}</div>{{ profile.clientId }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("recurring.columns.docType") }}</div>{{ t(`enums.recurringDocType.${profile.documentType ?? "invoice"}`) }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("recurring.fields.currency") }}</div>{{ profile.currency }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("recurring.fields.startDate") }}</div>{{ profile.startDate }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("recurring.columns.nextRun") }}</div>{{ profile.nextRunAt }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("recurring.fields.endDate") }}</div>{{ profile.endDate ?? "—" }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("recurring.fields.maxOccurrences") }}</div>{{ profile.maxOccurrences ?? "—" }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("recurring.occurrences") }}</div>{{ profile.occurrencesGenerated }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("recurring.lastRun") }}</div>{{ profile.lastRunAt ?? "—" }}</v-col>
        </v-row>

        <template #actions>
          <div class="d-flex align-center" style="gap: 8px; flex-wrap: wrap; width: 100%">
            <v-spacer />
            <v-btn v-if="canGenerate" color="primary" :loading="acting" prepend-icon="mdi-play" @click="generate">
              {{ t("recurring.generateNow") }}
            </v-btn>
            <v-btn v-if="isActive" color="warning" variant="outlined" :loading="acting" @click="pause">
              {{ t("recurring.pause") }}
            </v-btn>
            <v-btn v-if="isPaused" color="success" variant="outlined" :loading="acting" @click="resume">
              {{ t("recurring.resume") }}
            </v-btn>
            <v-btn v-if="canCancel" color="error" variant="outlined" :loading="acting" @click="cancel">
              {{ t("recurring.cancel") }}
            </v-btn>
          </div>
        </template>
      </AppCard>

      <v-card variant="outlined" rounded="lg" class="mb-4">
        <v-card-text>
        <div class="text-subtitle-2 mb-2">{{ t("recurring.lineItems") }}</div>
        <v-table density="compact">
          <thead>
            <tr>
              <th>{{ t("recurring.lineCols.description") }}</th>
              <th class="text-right">{{ t("recurring.lineCols.qty") }}</th>
              <th class="text-right">{{ t("recurring.lineCols.unit") }}</th>
              <th class="text-right">{{ t("recurring.lineCols.total") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(li, i) in profile.lineItems" :key="i">
              <td>{{ li.description }}</td>
              <td class="text-right">{{ li.quantity }}</td>
              <td class="text-right">{{ minorToDisplay(li.unitPriceMinor, profile.currency) }}</td>
              <td class="text-right">{{ minorToDisplay(li.lineTotalMinor, profile.currency) }}</td>
            </tr>
          </tbody>
        </v-table>
        <v-divider class="my-3" />
        <div class="d-flex justify-end">
          <div style="min-width: 240px">
            <div class="d-flex justify-space-between">
              <span>{{ t("recurring.totals.subtotal") }}</span><span>{{ minorToDisplay(profile.subtotalMinor, profile.currency) }}</span>
            </div>
            <div class="d-flex justify-space-between">
              <span>{{ t("recurring.totals.tax") }}</span><span>{{ minorToDisplay(profile.taxMinor, profile.currency) }}</span>
            </div>
            <div class="d-flex justify-space-between text-subtitle-1 font-weight-medium">
              <span>{{ t("recurring.totals.total") }}</span><span>{{ minorToDisplay(profile.grandTotalMinor, profile.currency) }}</span>
            </div>
          </div>
        </div>
        </v-card-text>
      </v-card>
    </template>

    <v-snackbar v-model="toast" :color="toastColor" :timeout="4000">
      {{ toastText }}
    </v-snackbar>
  </div>
</template>
