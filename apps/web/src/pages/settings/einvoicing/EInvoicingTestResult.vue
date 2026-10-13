<script setup lang="ts">
/** The four-check result of POST /settings/einvoicing/test (shared by the wizard and the connected header). */
import { useI18n } from "vue-i18n";
import type { EInvoicingTestResult } from "@/types/domain";

defineProps<{ result: EInvoicingTestResult; ok?: boolean }>();

const { t } = useI18n();
</script>

<template>
  <v-alert
    :type="(ok ?? result.ok) ? 'success' : 'error'"
    variant="tonal"
    density="compact"
    class="mt-3"
    role="status"
    data-test="einvoicing-test-result"
  >
    <div class="font-weight-medium mb-1">{{ (ok ?? result.ok) ? t("einvoicing.connection.testOk") : t("einvoicing.connection.testFailed") }}</div>
    <div v-for="c in result.checks" :key="c.key" class="d-flex align-center" style="gap: 6px" :data-test="`check-${c.key}`">
      <v-icon :icon="c.ok ? 'mdi-check' : 'mdi-close'" size="small" />
      <span>{{ t(`einvoicing.connection.checks.${c.key}`) }}</span>
      <span v-if="c.message" class="text-caption text-medium-emphasis">— {{ c.message }}</span>
    </div>
  </v-alert>
</template>
