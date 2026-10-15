<script setup lang="ts">
/**
 * InvoiceLink — a router link to an invoice, labelled with its NUMBER (never the
 * raw id). Pass `number` when the parent already knows it; otherwise the invoice
 * is fetched (GET /v1/invoices/:id). A draft (unnumbered) invoice or a failed
 * lookup falls back to a neutral "View invoice".
 */
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/api/client";
import type { Invoice } from "@/types/domain";

const props = withDefaults(defineProps<{ invoiceId: string; number?: string | null }>(), { number: null });

const { t } = useI18n();

const fetchNumber = async (id: string): Promise<string | null> => {
  try {
    return (await api.get<Invoice>(`/v1/invoices/${id}`)).invoiceNumber ?? null;
  } catch {
    return null;
  }
};

const fetched = ref<string | null>(null);
watch(
  () => [props.invoiceId, props.number] as const,
  async ([id, number]) => {
    fetched.value = null;
    if (number || !id) return;
    const resolved = await fetchNumber(id);
    if (id === props.invoiceId) fetched.value = resolved;
  },
  { immediate: true },
);

const label = computed<string>(() => props.number || fetched.value || t("invoices.viewInvoice"));
</script>

<template>
  <router-link :to="{ name: 'invoice-detail', params: { id: props.invoiceId } }" class="invoice-link">
    {{ label }}
  </router-link>
</template>

<style scoped>
.invoice-link {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
  text-decoration: none;
  overflow-wrap: anywhere;
}
.invoice-link:hover,
.invoice-link:focus-visible {
  text-decoration: underline;
}
</style>
