<script setup lang="ts">
/**
 * EInvoiceStatusChip — the SdI transmission status of a document as a coloured
 * chip. Colour is a role; the label text always carries the status.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { EInvoiceStatus } from "@/types/domain";

const props = defineProps<{ status?: EInvoiceStatus | null; size?: "x-small" | "small" }>();

const { t } = useI18n();

const COLORS: Record<EInvoiceStatus, string> = {
  not_sent: "surface-variant",
  blocked: "warning",
  queued: "info",
  transmitted: "info",
  awaiting_delivery: "info",
  delivered: "success",
  undelivered_attested: "success",
  accepted_by_pa: "success",
  rejected_by_pa: "error",
  rejected: "error",
  failed: "error",
};

const label = computed<string>(() => (props.status ? t(`einvoicing.status.${props.status}`) : "—"));
const color = computed<string>(() => (props.status && COLORS[props.status]) || "surface-variant");
</script>

<template>
  <v-chip :color="color" :size="size ?? 'small'" variant="tonal" label data-test="einvoice-status-chip">{{ label }}</v-chip>
</template>
