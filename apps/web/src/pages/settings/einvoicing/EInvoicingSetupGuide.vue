<script setup lang="ts">
/**
 * Collapsible setup guide for the e-invoicing tab. Each step shows a live
 * check / cross taken from the server's `readiness` checklist (matched by key,
 * with local fallbacks for the steps the settings view itself can answer), then a
 * "send later" deadline note and a "what the statuses mean" box (NS / MC / AT).
 * Open until setup is complete, collapsed afterwards.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { EInvoicingSettings } from "@/types/domain";

const props = defineProps<{ view: EInvoicingSettings }>();

const { t } = useI18n();

type StepKey = "company" | "taxRegime" | "iban" | "connect" | "channel" | "clients" | "test" | "defaults";

/** The server's readiness keys are business / iban / connection / channel; the other
 *  steps (tax regime, clients, test, defaults) are answered locally or stay neutral. */
const ALIASES: Record<StepKey, string[]> = {
  company: ["business"],
  taxRegime: [],
  iban: ["iban"],
  connect: ["connection"],
  channel: ["channel"],
  clients: [],
  test: [],
  defaults: [],
};

const STEPS: StepKey[] = ["company", "taxRegime", "iban", "connect", "channel", "clients", "test", "defaults"];

const fromReadiness = (step: StepKey): boolean | undefined =>
  props.view.readiness.find((r) => ALIASES[step].includes(r.key))?.ok;

/** true = done, false = todo, undefined = nothing to measure (neutral dot). */
const stateOf = (step: StepKey): boolean | undefined => {
  const server = fromReadiness(step);
  if (server !== undefined) return server;
  switch (step) {
    case "taxRegime":
      return props.view.taxRegime ? true : false;
    case "connect":
      return props.view.connected;
    case "channel":
      return props.view.channel !== null;
    case "test":
      return props.view.lastHealth?.ok === true;
    default:
      return undefined;
  }
};

const steps = computed(() => STEPS.map((key) => ({ key, ok: stateOf(key) })));
const complete = computed<boolean>(() => props.view.readiness.length > 0 ? props.view.readiness.every((r) => r.ok) : steps.value.every((s) => s.ok !== false));

// Open until setup is complete.
const open = ref<number[]>(complete.value ? [] : [0]);

const icon = (ok: boolean | undefined): string =>
  ok === true ? "mdi-check-circle" : ok === false ? "mdi-close-circle" : "mdi-circle-small";
const color = (ok: boolean | undefined): string | undefined => (ok === true ? "success" : ok === false ? "error" : undefined);
</script>

<template>
  <v-expansion-panels v-model="open" multiple variant="accordion" data-test="einvoicing-guide">
    <v-expansion-panel eager>
      <v-expansion-panel-title>
        <v-icon :icon="complete ? 'mdi-check-circle' : 'mdi-progress-check'" :color="complete ? 'success' : 'warning'" class="mr-2" />
        {{ t("einvoicing.guide.title") }}
      </v-expansion-panel-title>
      <v-expansion-panel-text>
        <ol class="guide-steps pl-0">
          <li v-for="(step, i) in steps" :key="step.key" class="d-flex mb-3" style="gap: 10px" :data-test="`guide-step-${step.key}`">
            <v-icon
              :icon="icon(step.ok)"
              :color="color(step.ok)"
              size="small"
              class="mt-1"
              :data-state="step.ok === true ? 'ok' : step.ok === false ? 'todo' : 'n/a'"
            />
            <div>
              <div class="text-body-2 font-weight-medium">{{ i + 1 }}. {{ t(`einvoicing.guide.steps.${step.key}.title`) }}</div>
              <div class="text-caption text-medium-emphasis">{{ t(`einvoicing.guide.steps.${step.key}.body`) }}</div>
            </div>
          </li>
        </ol>

        <v-alert type="info" variant="tonal" density="compact" class="mb-3" data-test="guide-send-later">
          {{ t("einvoicing.guide.sendLater", { days: view.sendDeadlineDays }) }}
        </v-alert>

        <v-card variant="outlined" rounded="lg" data-test="guide-statuses">
          <v-card-text>
            <div class="text-subtitle-2 mb-2">{{ t("einvoicing.guide.statusesTitle") }}</div>
            <div class="mb-1"><strong>NS</strong> — {{ t("einvoicing.guide.ns") }}</div>
            <div class="mb-1"><strong>MC</strong> — {{ t("einvoicing.guide.mc") }}</div>
            <div><strong>AT</strong> — {{ t("einvoicing.guide.at") }}</div>
          </v-card-text>
        </v-card>
      </v-expansion-panel-text>
    </v-expansion-panel>
  </v-expansion-panels>
</template>

<style scoped>
.guide-steps {
  list-style: none;
}
</style>
