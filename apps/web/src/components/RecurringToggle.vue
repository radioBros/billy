<script setup lang="ts">
/**
 * Reusable "Make this recurring" control, shared across the invoice, proforma
 * and expense CREATE forms (DRY — the recurrence UI lives in exactly one place).
 *
 * A `v-switch` toggles recurrence on. When ON it reveals the recurrence fields
 * (interval / interval count / start date / optional end date / optional max
 * occurrences) and the component v-models a typed `RecurrenceConfig`. When OFF
 * it v-models `null` so the host form can branch on "recurring or not" without
 * inspecting an `enabled` flag.
 *
 * The recurrence field labels + interval option titles reuse the existing
 * `recurring.*` i18n slice; the switch/hint copy lives under `recurring.toggle.*`.
 * Flat theme: the reveal panel is an outlined (shadowless) card.
 */
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { PlaceholderDocType } from "@billy/shared/template";
import type { RecurrenceConfig, RecurringAutoSend, RecurringInterval } from "@/types/domain";
import AutoSendConfigModal from "@/components/AutoSendConfigModal.vue";
import { useEInvoicing } from "@/stores/einvoicing";
import { useIsMobile } from "@/composables/useIsMobile";

const { t } = useI18n();
const einvoicing = useEInvoicing();
void einvoicing.load();
const isMobile = useIsMobile();

const model = defineModel<RecurrenceConfig | null>({ default: null });

const props = defineProps<{
  /** Disable the whole control (e.g. while the host form is saving). */
  disabled?: boolean;
  /** Doc family for the auto-send email config (placeholder tokens). OMIT to hide
   *  the auto-send section entirely (e.g. expenses generate nothing to email). */
  docType?: PlaceholderDocType | null;
  /** Selected client's email — prefilled as the auto-send recipient. */
  defaultTo?: string | null;
}>();

const INTERVALS: RecurringInterval[] = ["weekly", "monthly", "quarterly", "yearly"];

const intervalOptions = computed(() =>
  INTERVALS.map((i) => ({ value: i, title: t(`recurring.interval.${i}`) })),
);

// Local recurrence state, mirrored into the model whenever the switch is on.
const enabled = ref<boolean>(model.value?.enabled ?? false);
const interval = ref<RecurringInterval>(model.value?.interval ?? "monthly");
const intervalCount = ref<number>(model.value?.intervalCount ?? 1);
const startDate = ref<string>(model.value?.startDate ?? new Date().toISOString().slice(0, 10));
const endDate = ref<string>(model.value?.endDate ?? "");
const maxOccurrences = ref<number | null>(model.value?.maxOccurrences ?? null);
// Day-of-month anchor ("every Nth of month"). null ⇒ off (repeat on the start
// day). Only meaningful for monthly-family cadences.
const dayOfMonth = ref<number | null>(model.value?.dayOfMonth ?? null);

/** Monthly-family cadences support the "every Nth of month" anchor; weekly doesn't. */
const supportsDayAnchor = computed<boolean>(() => interval.value !== "weekly");

/** "start" (repeat on the start day) vs "day" (a fixed day of the month). */
const monthlyMode = computed<"start" | "day">({
  get: () => (dayOfMonth.value != null ? "day" : "start"),
  set: (mode) => {
    dayOfMonth.value = mode === "day" ? (dayOfMonth.value ?? 1) : null;
  },
});

const monthlyModeOptions = computed(() => [
  { value: "start", title: t("recurring.fields.repeatOnStartDay") },
  { value: "day", title: t("recurring.fields.repeatOnDayOfMonth") },
]);

/** 1..31 for the day-of-month picker. */
const dayOptions = Array.from({ length: 31 }, (_, i) => i + 1);

const countRule = (v: number): boolean | string => Number(v) >= 1 || t("recurring.countRule");
const endRule = (v: string): boolean | string =>
  !startDate.value || !v || v >= startDate.value || t("recurring.endRule");

// ── Auto-send (per-occurrence email) ─────────────────────────────────────────
// The switch opens the config modal (fields prefilled: client email + a
// placeholder template). Saving keeps it on; closing without a saved config
// flips it back off, so ON always means "configured".
const autoSend = ref<RecurringAutoSend | null>(model.value?.autoSend ?? null);
const autoSendOn = ref<boolean>(autoSend.value?.enabled === true);
const autoSendModal = ref(false);

const onAutoSendToggle = (value: unknown): void => {
  if (value) {
    autoSendModal.value = true;
  } else {
    autoSend.value = null;
    sync();
  }
};

const onAutoSendSave = (config: RecurringAutoSend): void => {
  autoSend.value = config.enabled ? config : null;
  autoSendOn.value = config.enabled;
  sync();
};

watch(autoSendModal, (open) => {
  // Closed without a saved config → the switch goes back off.
  if (!open && autoSend.value?.enabled !== true) autoSendOn.value = false;
});

// ── SdI (Italian e-invoicing): send each generated INVOICE officially ─────────
// Only offered for invoices while e-invoicing is enabled. Defaults to the account's
// `recurringDefaultSubmit` until the user touches the switch.
const showSdi = computed<boolean>(() => props.docType === "invoice" && einvoicing.enabled);
const autoSubmit = ref<boolean>(model.value?.einvoice?.autoSubmit ?? einvoicing.recurringDefaultSubmit);
const autoSubmitTouched = ref<boolean>(model.value?.einvoice != null);
watch(
  () => einvoicing.recurringDefaultSubmit,
  (def) => {
    if (!autoSubmitTouched.value) autoSubmit.value = def;
  },
);
const onAutoSubmit = (value: boolean | null): void => {
  autoSubmitTouched.value = true;
  autoSubmit.value = value === true;
};

const sync = (): void => {
  if (!enabled.value) {
    model.value = null;
    return;
  }
  model.value = {
    enabled: true,
    interval: interval.value,
    intervalCount: Number(intervalCount.value),
    // The anchor only applies to monthly-family cadences.
    dayOfMonth: supportsDayAnchor.value && dayOfMonth.value != null ? Number(dayOfMonth.value) : null,
    startDate: startDate.value,
    endDate: endDate.value.trim() || null,
    maxOccurrences:
      maxOccurrences.value === null || maxOccurrences.value === undefined
        ? null
        : Number(maxOccurrences.value),
    autoSend: autoSend.value,
    ...(showSdi.value ? { einvoice: { autoSubmit: autoSubmit.value } } : {}),
  };
};

// Switching to weekly clears any anchor (it doesn't apply there).
watch(interval, () => {
  if (!supportsDayAnchor.value) dayOfMonth.value = null;
});

watch([enabled, interval, intervalCount, startDate, endDate, maxOccurrences, dayOfMonth, autoSubmit, showSdi], sync);
</script>

<template>
  <!-- Phone: settings-style rows (icon badge · label · switch on the right) and
       paired half-width fields; desktop markup is unchanged. -->
  <v-card variant="outlined" rounded="lg" class="mb-4" :class="{ 'recurring-toggle--mobile': isMobile }">
    <v-card-text>
    <v-switch
      v-model="enabled"
      :label="t('recurring.toggle.enable')"
      color="primary"
      hide-details
      :disabled="props.disabled"
    >
      <template v-if="isMobile" #prepend>
        <span class="recurring-toggle__badge"><v-icon icon="mdi-repeat" size="20" /></span>
      </template>
    </v-switch>
    <div v-if="enabled" class="text-caption mb-3 recurring-toggle__hint" style="color: var(--v-billy-text-3)">
      {{ t("recurring.toggle.hint") }}
    </div>

    <v-row v-if="enabled">
      <!-- Phone: count first, so the pair reads "Every [1] [Monthly]". -->
      <v-col :cols="isMobile ? 6 : 12" md="4">
        <v-select
          v-model="interval"
          :items="intervalOptions"
          :label="t('recurring.fields.interval')"
          :disabled="props.disabled"
          density="comfortable"
        />
      </v-col>
      <v-col :cols="isMobile ? 6 : 12" md="4" :order="isMobile ? 'first' : undefined">
        <v-text-field
          v-model.number="intervalCount"
          :label="t('recurring.fields.intervalCount')"
          type="number"
          min="1"
          :rules="[countRule]"
          :disabled="props.disabled"
          density="comfortable"
        />
      </v-col>
      <v-col cols="12" md="4">
        <v-text-field
          v-model.number="maxOccurrences"
          :label="t('recurring.fields.maxOccurrences')"
          type="number"
          min="1"
          clearable
          :disabled="props.disabled"
          density="comfortable"
        />
      </v-col>
      <!-- "Every Nth of month" anchor — monthly-family cadences only. -->
      <v-col v-if="supportsDayAnchor" cols="12" :md="monthlyMode === 'day' ? 6 : 12">
        <v-select
          v-model="monthlyMode"
          :items="monthlyModeOptions"
          :label="t('recurring.fields.repeatOn')"
          :disabled="props.disabled"
          density="comfortable"
        />
      </v-col>
      <v-col v-if="supportsDayAnchor && monthlyMode === 'day'" cols="12" md="6">
        <v-select
          v-model.number="dayOfMonth"
          :items="dayOptions"
          :label="t('recurring.fields.dayOfMonth')"
          :hint="t('recurring.fields.dayOfMonthHint')"
          persistent-hint
          :disabled="props.disabled"
          density="comfortable"
        />
      </v-col>
      <v-col cols="12" md="6">
        <v-text-field
          v-model="startDate"
          :label="t('recurring.fields.startDate')"
          type="date"
          :disabled="props.disabled"
          density="comfortable"
        />
      </v-col>
      <v-col cols="12" md="6">
        <v-text-field
          v-model="endDate"
          :label="t('recurring.fields.endDate')"
          type="date"
          :rules="[endRule]"
          :disabled="props.disabled"
          density="comfortable"
        />
      </v-col>
    </v-row>

    <!-- Auto-send: each generated occurrence is emailed automatically. Hidden for
         doc types that generate nothing to email (no docType prop, e.g. expenses). -->
    <template v-if="enabled && docType">
      <v-divider class="my-2" />
      <v-switch
        :model-value="autoSendOn"
        data-test="recurring-autosend-switch"
        color="primary"
        hide-details
        :label="t('recurring.autoSend.enable')"
        :disabled="props.disabled"
        @update:model-value="onAutoSendToggle"
      >
        <template v-if="isMobile" #prepend>
          <span class="recurring-toggle__badge"><v-icon icon="mdi-email-fast-outline" size="20" /></span>
        </template>
      </v-switch>
      <div
        v-if="autoSend?.enabled"
        class="d-flex align-center flex-wrap"
        :class="{ 'recurring-toggle__summary': isMobile }"
        style="gap: 8px"
      >
        <span class="text-caption" style="color: var(--v-billy-text-3)">
          {{ t("recurring.autoSend.summary", { to: autoSend.to ?? "", subject: autoSend.subject ?? "" }) }}
        </span>
        <v-btn
          size="small"
          variant="tonal"
          color="primary"
          prepend-icon="mdi-email-edit-outline"
          :disabled="props.disabled"
          data-test="recurring-autosend-configure"
          @click="autoSendModal = true"
        >
          {{ t("recurring.autoSend.configure") }}
        </v-btn>
      </div>
      <v-switch
        v-if="showSdi"
        :model-value="autoSubmit"
        data-test="recurring-sdi-switch"
        color="primary"
        hide-details
        :label="t('einvoicing.recurring.switch')"
        :disabled="props.disabled"
        @update:model-value="onAutoSubmit"
      >
        <template v-if="isMobile" #prepend>
          <span class="recurring-toggle__badge"><v-icon icon="mdi-file-send-outline" size="20" /></span>
        </template>
      </v-switch>
    </template>
    </v-card-text>
  </v-card>

  <AutoSendConfigModal
    v-if="docType"
    v-model="autoSendModal"
    :doc-type="docType"
    :config="autoSend"
    :default-to="defaultTo"
    initial-enabled
    @save="onAutoSendSave"
  />
</template>

<style scoped>
/* ── Phone ──────────────────────────────────────────────────────────────── */
.recurring-toggle--mobile {
  border-radius: 16px !important;
}
.recurring-toggle--mobile > :deep(.v-card-text) {
  padding: 4px 12px 8px;
}
/* Switch rows: badge · label (fills) · switch on the right, ≥ 52px tall. */
.recurring-toggle--mobile :deep(.v-switch) {
  min-height: 52px;
}
.recurring-toggle--mobile :deep(.v-switch > .v-input__prepend) {
  margin-inline-end: 12px;
  align-self: center;
}
.recurring-toggle--mobile :deep(.v-switch .v-selection-control) {
  flex-direction: row-reverse;
  min-height: 52px;
}
.recurring-toggle--mobile :deep(.v-switch .v-label) {
  flex: 1 1 auto;
  min-width: 0;
  padding-inline: 0 8px;
  font-size: 0.9375rem;
  font-weight: 600;
  line-height: 1.3;
  opacity: 1;
  white-space: normal;
}
.recurring-toggle__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: rgba(var(--v-theme-primary), 0.1);
  color: rgb(var(--v-theme-primary));
}
.recurring-toggle--mobile .recurring-toggle__hint {
  margin: -6px 0 0 48px;
  margin-bottom: 24px !important; /* beats the .mb-3 utility */
  line-height: 1.4;
}
.recurring-toggle--mobile :deep(.v-divider) {
  margin-inline: -12px;
}
/* Auto-send summary: a soft box under its switch, text wraps, button full width. */
.recurring-toggle__summary {
  margin: 0 0 8px 48px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.recurring-toggle__summary > span {
  flex: 1 1 100%;
  overflow-wrap: anywhere;
}
.recurring-toggle__summary > :deep(.v-btn) {
  flex: 1 1 100%;
  height: 40px;
}
</style>
