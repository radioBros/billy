<script setup lang="ts">
/**
 * Floating live-timer overlay (time-tracking follow-up D). Mounted ONCE in
 * AppShell so it floats app-wide and survives route navigation. Reads its state
 * from the pinia timer store (which persists to localStorage, so a refresh keeps
 * a running timer). Renders only while a timer is active.
 *
 * Controls: Start/Resume, Pause, Stop. Stop folds the elapsed time and opens a
 * compact dialog pre-filled with the elapsed DURATION (whole minutes), letting
 * the user confirm/add a description, optional client, optional project and the
 * billable flag, then creates the time entry via POST /v1/time-entries (the same
 * endpoint TimeEntryForm uses). On success the timer is fully cleared.
 */
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import type { TimeEntry } from "@/types/domain";
import { useTimerStore } from "@/stores/timer";
import ClientSelector from "@/components/ClientSelector.vue";

const { t } = useI18n();
const timer = useTimerStore();

// ---- Stop → confirm dialog --------------------------------------------------

const dialog = ref(false);
const saving = ref(false);
const errorMessage = ref<string | null>(null);
const formValid = ref(false);

// Pre-filled fields for the created time entry.
const pendingMinutes = ref(0);
const description = ref("");
const date = ref(new Date().toISOString().slice(0, 10));
const clientId = ref<string | null>(null);
const projectId = ref("");
const billable = ref(true);

const required = (v: unknown): boolean | string =>
  (!!v && String(v).trim().length > 0) || t("common.required");

const durationLabel = computed<string>(() => {
  const total = Math.max(0, pendingMinutes.value);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
});

const onStop = (): void => {
  // Fold + read the elapsed minutes, then clear the running timer. The dialog
  // now owns the value; if the user cancels we simply discard it.
  pendingMinutes.value = timer.stop();
  description.value = "";
  clientId.value = null;
  projectId.value = "";
  billable.value = true;
  date.value = new Date().toISOString().slice(0, 10);
  errorMessage.value = null;
  dialog.value = true;
};

const confirmCreate = async (): Promise<void> => {
  errorMessage.value = null;
  saving.value = true;
  const payload: Record<string, unknown> = {
    description: description.value.trim(),
    date: date.value,
    durationMinutes: Math.max(0, Math.round(pendingMinutes.value)),
    billable: billable.value,
  };
  if (clientId.value) payload.clientId = clientId.value;
  if (projectId.value.trim()) payload.projectId = projectId.value.trim();
  try {
    await api.post<TimeEntry>("/v1/time-entries", payload);
    dialog.value = false;
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError
        ? t("timeEntries.saveError", { code: err.code })
        : t("timeEntries.saveErrorGeneric");
  } finally {
    saving.value = false;
  }
};

const cancelDialog = (): void => {
  // The timer was already cleared by stop(); closing simply discards the entry.
  dialog.value = false;
};
</script>

<template>
  <div>
    <!-- Floating widget — only while a timer is active. -->
    <v-card
      v-if="timer.active"
      class="timer-overlay"
      elevation="8"
      rounded="lg"
    >
      <div class="d-flex align-center px-3 py-2" style="gap: 10px">
        <v-icon
          :icon="timer.running ? 'mdi-timer-outline' : 'mdi-timer-pause-outline'"
          :color="timer.running ? 'primary' : undefined"
          size="20"
        />
        <span class="text-h6 font-weight-medium timer-overlay__time">{{ timer.display }}</span>
        <v-spacer />
        <v-btn
          v-if="!timer.running"
          icon="mdi-play"
          variant="text"
          size="small"
          color="primary"
          :aria-label="t('timer.resume')"
          @click="timer.resume()"
        />
        <v-btn
          v-else
          icon="mdi-pause"
          variant="text"
          size="small"
          :aria-label="t('timer.pause')"
          @click="timer.pause()"
        />
        <v-btn
          icon="mdi-stop"
          variant="text"
          size="small"
          color="error"
          :aria-label="t('timer.stop')"
          @click="onStop"
        />
      </div>
    </v-card>

    <!-- Stop → confirm/create dialog, pre-filled with the elapsed duration. -->
    <v-dialog v-model="dialog" max-width="520" persistent>
      <v-card rounded="lg">
        <v-card-title class="text-h6">{{ t("timer.saveTitle") }}</v-card-title>
        <v-card-text>
          <v-alert
            v-if="errorMessage"
            type="error"
            variant="tonal"
            density="compact"
            class="mb-3"
            role="alert"
          >
            {{ errorMessage }}
          </v-alert>

          <div class="d-flex align-center mb-4" style="gap: 8px">
            <v-icon icon="mdi-timer-outline" size="20" />
            <span class="text-body-1">{{ t("timer.durationLabel") }}:</span>
            <strong>{{ durationLabel }}</strong>
          </div>

          <v-form v-model="formValid" @submit.prevent="confirmCreate">
            <v-text-field
              v-model="description"
              :label="t('timeEntries.fields.description')"
              :rules="[required]"
              density="comfortable"
              class="mb-2"
            />
            <v-text-field
              v-model="date"
              :label="t('timeEntries.fields.date')"
              type="date"
              :rules="[required]"
              density="comfortable"
              class="mb-2"
            />
            <ClientSelector
              v-model="clientId"
              :label="t('subscriptions.fields.client')"
              class="mb-2"
            />
            <v-text-field
              v-model="projectId"
              :label="t('timeEntries.fields.projectId')"
              density="comfortable"
              :hint="t('timeEntries.projectIdHint')"
              persistent-hint
              class="mb-2"
            />
            <v-switch
              v-model="billable"
              :label="t('timeEntries.fields.billable')"
              color="primary"
              density="comfortable"
              hide-details
            />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="cancelDialog">{{ t("timer.discard") }}</v-btn>
          <v-btn color="primary" :loading="saving" @click="confirmCreate">
            {{ t("timer.saveEntry") }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.timer-overlay {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 2000;
  min-width: 220px;
  background: rgb(var(--v-theme-surface));
}

.timer-overlay__time {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.5px;
}
</style>
