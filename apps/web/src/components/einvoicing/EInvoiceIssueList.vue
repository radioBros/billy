<script setup lang="ts">
/**
 * EInvoiceIssueList — preflight issues (errors + warnings) with a "Fix" link that
 * opens the client / company settings / e-invoicing settings in a NEW tab, so the
 * half-finished document flow in this tab is never lost. Issue codes map to
 * `einvoicing.issues.<code>`; an unknown code falls back to the raw code.
 */
import { useI18n } from "vue-i18n";
import type { EInvoicePreflightIssue } from "@/types/domain";
import { fixHref } from "@/composables/useEInvoice";

defineProps<{
  issues: EInvoicePreflightIssue[];
  /** Client of the document — target of "client" fixes. */
  clientId?: string | null;
}>();

const { t, te } = useI18n();

const message = (issue: EInvoicePreflightIssue): string => {
  const key = `einvoicing.issues.${issue.code}`;
  return te(key) ? t(key, issue.params ?? {}) : issue.code;
};
</script>

<template>
  <!-- v-virtual-scroll: project rule for any list of rows. -->
  <v-virtual-scroll :items="issues" max-height="280" data-test="einvoice-issues">
    <template #default="{ item: issue }">
      <div
        class="d-flex align-center py-1"
        style="gap: 8px"
        :data-test="`issue-${issue.code}`"
      >
        <v-icon
          :icon="issue.severity === 'error' ? 'mdi-close-circle' : 'mdi-alert'"
          :color="issue.severity === 'error' ? 'error' : 'warning'"
          size="small"
        />
        <span class="text-body-2 flex-grow-1">{{ message(issue) }}</span>
        <v-btn
          v-if="fixHref(issue, clientId)"
          size="small"
          variant="text"
          color="primary"
          :href="fixHref(issue, clientId) ?? undefined"
          target="_blank"
          rel="noopener"
          append-icon="mdi-open-in-new"
          data-test="issue-fix"
        >
          {{ t("einvoicing.fix") }}
        </v-btn>
      </div>
    </template>
  </v-virtual-scroll>
</template>
