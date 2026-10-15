<script setup lang="ts">
/**
 * "What to enable on OpenAPI.it": the checklist an admin must work through in the
 * OpenAPI console before the channel test can pass. Open by default.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useIsMobile } from "@/composables/useIsMobile";

const props = defineProps<{ signing: boolean; vatNumber?: string | null }>();
const { t } = useI18n();
const isMobile = useIsMobile();

const open = ref<string | undefined>("notice");

/** The registry wants the VAT number WITHOUT the IT prefix. */
const fiscalId = computed<string>(() => (props.vatNumber ?? "").trim().replace(/^IT/iu, "").replace(/\s+/gu, ""));
const hasVat = computed<boolean>(() => fiscalId.value.length > 0);

/** Endpoints are literal API paths (not translated); `when` keys the human label. */
const endpoints = computed(() => [
  { key: "send", call: "POST /invoices", when: "always" },
  { key: "sign", call: "POST /invoices_signature", when: "signing" },
  { key: "legal", call: "POST /invoices_legal_storage, POST /invoices_signature_legal_storage", when: "legal" },
  { key: "read", call: "GET /invoices/{uuid}", when: "always" },
  { key: "receipts", call: "GET /invoices_notifications/{uuid}", when: "always" },
  { key: "registry", call: "GET, POST /business_registry_configurations", when: "always" },
  { key: "callback", call: "POST /api_configurations", when: "callback" },
]);
</script>

<template>
  <v-expansion-panels v-model="open" variant="accordion" class="oa-notice" data-test="openapi-notice">
    <v-expansion-panel value="notice" rounded="lg" bg-color="transparent">
      <v-expansion-panel-title class="oa-notice__title">
        <v-icon icon="mdi-clipboard-check-outline" color="primary" class="mr-3" />
        <span class="font-weight-medium">{{ t("einvoicing.channel.openapi.notice.title") }}</span>
      </v-expansion-panel-title>
      <v-expansion-panel-text>
        <p class="text-body-2 mb-3">{{ t("einvoicing.channel.openapi.notice.intro") }}</p>

        <ol class="oa-steps">
          <li data-test="notice-step-1">
            <div class="font-weight-medium">{{ t("einvoicing.channel.openapi.notice.s1.title") }}</div>
            <div class="text-body-2">{{ t("einvoicing.channel.openapi.notice.s1.body") }}</div>
          </li>

          <li data-test="notice-step-2">
            <div class="font-weight-medium">{{ t("einvoicing.channel.openapi.notice.s2.title") }}</div>
            <div class="text-body-2 mb-2">{{ t("einvoicing.channel.openapi.notice.s2.body") }}</div>
            <!-- Phone: the 3-column table becomes stacked endpoint rows. -->
            <div v-if="isMobile" class="oa-endpoints--m" data-test="notice-endpoints">
              <div v-for="e in endpoints" :key="e.key" class="oa-endpoints--m__row" :data-test="`notice-endpoint-${e.key}`">
                <code class="text-body-2 oa-endpoints--m__call">{{ e.call }}</code>
                <div class="text-body-2 text-medium-emphasis mt-1">{{ t(`einvoicing.channel.openapi.notice.table.purposes.${e.key}`) }}</div>
                <v-chip size="x-small" label variant="tonal" class="mt-1" :color="e.when === 'always' ? 'primary' : undefined">
                  {{ t(`einvoicing.channel.openapi.notice.table.whens.${e.when}`) }}
                </v-chip>
              </div>
            </div>
            <v-table v-else density="compact" class="oa-table rounded-lg border" data-test="notice-endpoints">
              <thead>
                <tr>
                  <th>{{ t("einvoicing.channel.openapi.notice.table.call") }}</th>
                  <th>{{ t("einvoicing.channel.openapi.notice.table.purpose") }}</th>
                  <th>{{ t("einvoicing.channel.openapi.notice.table.when") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="e in endpoints" :key="e.key" :data-test="`notice-endpoint-${e.key}`">
                  <td><code class="text-body-2">{{ e.call }}</code></td>
                  <td>{{ t(`einvoicing.channel.openapi.notice.table.purposes.${e.key}`) }}</td>
                  <td>
                    <v-chip size="x-small" label variant="tonal" :color="e.when === 'always' ? 'primary' : undefined">
                      {{ t(`einvoicing.channel.openapi.notice.table.whens.${e.when}`) }}
                    </v-chip>
                  </td>
                </tr>
              </tbody>
            </v-table>
          </li>

          <li data-test="notice-step-3">
            <div class="font-weight-medium">{{ t("einvoicing.channel.openapi.notice.s3.title") }}</div>
            <div class="text-body-2">{{ t("einvoicing.channel.openapi.notice.s3.body") }}</div>
            <div class="text-body-2 mt-1" data-test="notice-fiscal-id">
              {{ hasVat ? t("einvoicing.channel.openapi.notice.s3.fiscalId", { vat: fiscalId }) : t("einvoicing.channel.openapi.notice.s3.fiscalIdExample", { vat: "12345678903" }) }}
            </div>
            <div class="text-body-2 mt-1">
              {{ signing ? t("einvoicing.channel.openapi.notice.s3.signingOn") : t("einvoicing.channel.openapi.notice.s3.signingOff") }}
            </div>
            <div class="text-caption text-medium-emphasis mt-1">{{ t("einvoicing.channel.openapi.notice.s3.mismatch") }}</div>
          </li>

          <li data-test="notice-step-4">
            <div class="font-weight-medium">{{ t("einvoicing.channel.openapi.notice.s4.title") }}</div>
            <div class="text-body-2">{{ t("einvoicing.channel.openapi.notice.s4.body") }}</div>
          </li>

          <li data-test="notice-step-5">
            <div class="font-weight-medium">{{ t("einvoicing.channel.openapi.notice.s5.title") }}</div>
            <div class="text-body-2">{{ t("einvoicing.channel.openapi.notice.s5.body") }}</div>
          </li>
        </ol>

        <v-alert type="info" variant="tonal" density="comfortable" rounded="lg" icon="mdi-lightbulb-on-outline" class="mt-3" data-test="notice-tip">
          {{ t("einvoicing.channel.openapi.notice.tip") }}
        </v-alert>
      </v-expansion-panel-text>
    </v-expansion-panel>
  </v-expansion-panels>
</template>

<style scoped>
.oa-notice :deep(.v-expansion-panel) {
  background: rgba(var(--v-theme-primary), 0.05);
  border: 1px solid rgba(var(--v-theme-primary), 0.25);
  border-radius: 12px;
}
.oa-notice :deep(.v-expansion-panel::after) {
  display: none;
}
.oa-steps {
  list-style: none;
  counter-reset: oa;
  padding: 0;
  margin: 0;
}
.oa-steps > li {
  counter-increment: oa;
  position: relative;
  padding: 0 0 16px 40px;
}
.oa-steps > li::before {
  content: counter(oa);
  position: absolute;
  left: 0;
  top: 0;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8125rem;
  font-weight: 600;
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
}
.oa-steps > li:not(:last-child)::after {
  content: "";
  position: absolute;
  left: 13px;
  top: 32px;
  bottom: 4px;
  width: 2px;
  background: rgba(var(--v-theme-primary), 0.25);
}
.oa-endpoints--m {
  background: rgb(var(--v-theme-surface));
  border: 1px solid var(--v-billy-border, #e2e4e9);
  border-radius: 12px;
}
.oa-endpoints--m__row {
  padding: 10px 12px;
}
.oa-endpoints--m__row + .oa-endpoints--m__row {
  border-top: 1px solid var(--v-billy-border, #e2e4e9);
}
.oa-endpoints--m__call {
  display: block;
  overflow-wrap: anywhere;
}
/* Phone: the numbered rail takes less of the narrow width. */
@media (max-width: 599.98px) {
  .oa-steps > li {
    padding-left: 36px;
  }
}
.oa-table {
  background: rgb(var(--v-theme-surface));
}
.oa-table :deep(code) {
  word-break: break-word;
}
</style>
