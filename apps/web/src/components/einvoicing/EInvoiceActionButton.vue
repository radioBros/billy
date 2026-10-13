<script setup lang="ts">
/**
 * EInvoiceActionButton — the calm SdI status + toggle in the document header,
 * next to "Add payment". It shows the current SdI state in its label and expands
 * or collapses the (collapsed-by-default) EInvoicePanel; it never acts itself and
 * is never disabled. The host feeds it the `EInvoiceInfo` the panel already loaded.
 * Renders nothing when e-invoicing is off or there is nothing to show.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { EInvoiceInfo, EInvoiceStatus } from "@/types/domain";

const props = defineProps<{ info: EInvoiceInfo | null; open: boolean }>();
const emit = defineEmits<{ toggle: [] }>();

const { t } = useI18n();

const SENT: ReadonlySet<EInvoiceStatus> = new Set<EInvoiceStatus>([
  "awaiting_delivery",
  "delivered",
  "undelivered_attested",
  "accepted_by_pa",
  "rejected_by_pa",
]);

type Mode = "idle" | "sending" | "sent" | "rejected" | "failed";

const mode = computed<Mode | null>(() => {
  const i = props.info;
  if (!i || !i.enabled) return null;
  if (i.status === "rejected") return "rejected";
  if (i.status === "failed") return "failed";
  if (i.status === "queued" || i.status === "transmitted") return "sending";
  if (SENT.has(i.status)) return "sent";
  return "idle";
});

const label = computed<string>(() => {
  switch (mode.value) {
    case "sending":
      return t("einvoicing.actions.sending");
    case "sent":
      return t("einvoicing.actions.sentToSdi", { status: t(`einvoicing.status.${props.info!.status}`) });
    case "rejected":
      return t("einvoicing.actions.rejected");
    case "failed":
      return t("einvoicing.actions.failed");
    default:
      return t("einvoicing.actions.notSent");
  }
});

const color = computed<string>(() => {
  switch (mode.value) {
    case "sent":
      return "success";
    case "rejected":
      return "error";
    case "failed":
      return "warning";
    case "sending":
      return "info";
    default:
      return "default";
  }
});

const icon = computed<string | undefined>(() => {
  switch (mode.value) {
    case "sent":
      return "mdi-check-circle-outline";
    case "rejected":
      return "mdi-alert-circle-outline";
    case "failed":
      return "mdi-alert-outline";
    case "idle":
      return "mdi-file-send-outline";
    default:
      return undefined;
  }
});

const overdue = computed<boolean>(() => mode.value === "idle" && props.info?.deadline?.overdue === true);

const fmt = (iso: string | null | undefined): string => (iso ? iso.replace("T", " ").slice(0, 16) : "");

const tip = computed<string>(() => {
  const base = props.open ? t("einvoicing.actions.tipCollapse") : t("einvoicing.actions.tipExpand");
  const i = props.info;
  if (mode.value === "sent" && i) {
    const parts = [t("einvoicing.actions.tipSent", { date: fmt(i.submittedAt) || "—" })];
    if (i.identificativoSdI) parts.push(t("einvoicing.actions.tipSdiId", { id: i.identificativoSdI }));
    return `${parts.join(" · ")} — ${base}`;
  }
  return base;
});
</script>

<template>
  <v-btn
    v-if="mode"
    :color="color"
    variant="tonal"
    :prepend-icon="icon"
    :aria-expanded="open ? 'true' : 'false'"
    :data-mode="mode"
    data-test="einvoice-header-action"
    @click="emit('toggle')"
  >
    <v-progress-circular v-if="mode === 'sending'" indeterminate size="14" width="2" class="mr-2" />
    {{ label }}
    <span v-if="overdue" class="einvoice-dot" data-test="einvoice-overdue-dot" />
    <template #append>
      <v-icon icon="mdi-chevron-down" size="small" class="einvoice-chevron" :class="{ 'einvoice-chevron--open': open }" />
    </template>
    <v-tooltip activator="parent" location="bottom" :text="tip" />
  </v-btn>
</template>

<style scoped>
.einvoice-chevron {
  transition: transform 0.2s ease;
}
.einvoice-chevron--open {
  transform: rotate(180deg);
}
.einvoice-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-left: 8px;
  border-radius: 50%;
  background: rgb(var(--v-theme-warning));
}
</style>
