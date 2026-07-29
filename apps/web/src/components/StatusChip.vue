<script setup lang="ts">
/**
 * StatusChip — renders any document status as a colored chip. Colour is a role
 * (never colour-only meaning — the label text always carries the status), per
 * the component-library spec. Unknown statuses fall back to a neutral chip.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { enumLabel } from "@/utils/enums";

const props = defineProps<{ status?: string | null }>();

const { t } = useI18n();

const COLORS: Record<string, string> = {
  // shared
  draft: "surface-variant",
  archived: "surface-variant",
  // invoices
  scheduled: "warning",
  finalized: "info",
  sent: "info",
  partially_paid: "warning",
  paid: "success",
  void: "error",
  // quotes
  accepted: "success",
  declined: "error",
  expired: "warning",
  converted: "primary",
  // expenses
  invoiced: "primary",
  // contracts
  active: "success",
  expiring: "warning",
  terminated: "error",
  renewed: "primary",
  // subscriptions
  paused: "warning",
  cancelled: "error",
};

const label = computed<string>(() => enumLabel(t, "status", props.status));

const color = computed<string>(() => (props.status && COLORS[props.status]) || "surface-variant");
</script>

<template>
  <v-chip :color="color" size="small" variant="tonal" label>{{ label }}</v-chip>
</template>
