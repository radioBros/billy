<script setup lang="ts">
/**
 * EInvoiceSentChip — small always-visible chip in the document header saying the
 * document has gone to SdI (success), was rejected (error) or failed (warning).
 * Shows nothing when not sent. Fed by the `EInvoiceInfo` the panel already loaded.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useIsMobile } from "@/composables/useIsMobile";
import type { EInvoiceInfo, EInvoiceStatus } from "@/types/domain";

const props = defineProps<{ info: EInvoiceInfo | null }>();
const emit = defineEmits<{ click: [] }>();
const { t } = useI18n();
// Touch has no hover: a tap would pin the tooltip over the panel it just opened.
const isMobile = useIsMobile();

const SENT: ReadonlySet<EInvoiceStatus> = new Set<EInvoiceStatus>([
  "queued",
  "transmitted",
  "awaiting_delivery",
  "delivered",
  "undelivered_attested",
  "accepted_by_pa",
  "rejected_by_pa",
]);

const kind = computed<"sent" | "rejected" | "failed" | null>(() => {
  const i = props.info;
  if (!i || !i.enabled) return null;
  if (i.status === "rejected") return "rejected";
  if (i.status === "failed") return "failed";
  return SENT.has(i.status) ? "sent" : null;
});

const label = computed<string>(() => {
  if (kind.value === "rejected") return t("einvoicing.status.rejected");
  if (kind.value === "failed") return t("einvoicing.actions.failed");
  return t("einvoicing.actions.sentToSdi", { status: t(`einvoicing.status.${props.info!.status}`) });
});

const fmt = (iso: string | null | undefined): string => (iso ? iso.replace("T", " ").slice(0, 16) : "");

const tip = computed<string>(() => {
  const i = props.info;
  if (!i?.submittedAt && !i?.identificativoSdI) return label.value;
  const parts: string[] = [];
  if (i?.submittedAt) parts.push(t("einvoicing.actions.tipSent", { date: fmt(i.submittedAt) }));
  if (i?.identificativoSdI) parts.push(t("einvoicing.actions.tipSdiId", { id: i.identificativoSdI }));
  return parts.join(" · ");
});

const color = computed<string>(() => (kind.value === "rejected" ? "error" : kind.value === "failed" ? "warning" : "success"));
const icon = computed<string>(() =>
  kind.value === "sent" ? "mdi-check-decagram" : kind.value === "rejected" ? "mdi-alert-circle-outline" : "mdi-alert-outline",
);
</script>

<template>
  <v-chip
    v-if="kind"
    :color="color"
    :prepend-icon="icon"
    size="small"
    variant="tonal"
    label
    class="ml-2"
    :data-kind="kind"
    data-test="einvoice-sent-chip"
    @click="emit('click')"
  >
    {{ label }}
    <v-tooltip activator="parent" location="bottom" :text="tip" :disabled="isMobile" />
  </v-chip>
</template>
