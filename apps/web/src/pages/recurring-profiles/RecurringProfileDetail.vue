<script setup lang="ts">
/**
 * Recurring profile detail — shows the template + line items and the guarded
 * lifecycle actions (recurring-billing routes): pause/resume (active⇄paused),
 * cancel (→terminal), and "Generate now" (POST /:id/generate).
 *
 * The view is built to READ LIKE THE DOCUMENT it generates: the client is
 * resolved to its full details (not a raw id), the subject is shown, and a
 * "Preview" action renders the exact document an occurrence would produce
 * (via the same preview-draft endpoint the create forms use). Preview is only
 * available for the invoice/proforma families — `expense` has no PDF preview.
 *
 * All lifecycle transitions send the optimistic-concurrency `version` via
 * If-Match. `generate` is the ONE action that takes NO version (the route does
 * not resolve one) and returns an InvoiceDraftPayload | null.
 *
 * `createdInvoiceIds` links to the documents this profile has already generated
 * (appended by the jobs layer); empty until the scheduler produces occurrences.
 */
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import { useClientNames } from "@/composables/useClientNames";
import { apiErrorReason } from "@/utils/validationMessages";
import type { Client, InvoiceDraftPayload, LineItemInput, RecurringAutoSend, RecurringInterval, RecurringProfile } from "@/types/domain";
import type { PlaceholderDocType } from "@billy/shared/template";
import { minorToDisplay } from "@/utils/money";
import { localizedCountryName } from "@/constants/countries";
import StatusChip from "@/components/StatusChip.vue";
import AppCard from "@/components/AppCard.vue";
import DocumentPreviewDialog from "@/components/DocumentPreviewDialog.vue";
import AutoSendConfigModal from "@/components/AutoSendConfigModal.vue";
import LineItemEditor from "@/components/LineItemEditor.vue";

const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const id = computed<string>(() => route.params.id as string);

const profile = ref<RecurringProfile | null>(null);
const client = ref<Client | null>(null);
const { resolve: resolveClientNames, nameOf: clientNameOf } = useClientNames();
const loading = ref(false);
const errorMessage = ref<string | null>(null);
const actionError = ref<string | null>(null);
const acting = ref(false);

const toast = ref(false);
const toastText = ref("");
const toastColor = ref<"success" | "info">("success");

const isActive = computed<boolean>(() => profile.value?.status === "active");
const isPaused = computed<boolean>(() => profile.value?.status === "paused");
const canGenerate = computed<boolean>(() => isActive.value || isPaused.value);
const canCancel = computed<boolean>(() => isActive.value || isPaused.value);

const intervalLabel = (p: RecurringProfile): string => {
  const base = t(`recurring.interval.${p.interval}`);
  return p.intervalCount > 1 ? t("recurring.everyN", { n: p.intervalCount, unit: base }) : base;
};

/** Formatted client address lines (line1/line2 + postal · city · region · country). */
const clientAddressLines = computed<string[]>(() => {
  const a = client.value?.billingAddress;
  if (!a) return [];
  const lines: string[] = [];
  if (a.line1) lines.push(a.line1);
  if (a.line2) lines.push(a.line2);
  const locality = [a.postalCode, a.city, a.region ? `(${a.region})` : "", localizedCountryName(a.country, locale.value)]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (locality) lines.push(locality);
  return lines;
});

// ── Preview (renders the document an occurrence would produce). ──────────────
// Preview endpoints only exist for the invoice/proforma families; `expense`
// generates no PDF, so the button is hidden for it.
const PREVIEW_PATH: Partial<Record<RecurringProfile["documentType"], string>> = {
  invoice: "/v1/invoices/preview-draft",
  proforma: "/v1/proforma/preview-draft",
};
const canPreview = computed<boolean>(() => !!profile.value && !!PREVIEW_PATH[profile.value.documentType]);

const previewOpen = ref(false);
const previewHtml = ref<string | null>(null);
const previewLoading = ref(false);

const preview = async (): Promise<void> => {
  const p = profile.value;
  const path = p ? PREVIEW_PATH[p.documentType] : undefined;
  if (!p || !path) return;
  previewOpen.value = true;
  previewLoading.value = true;
  previewHtml.value = null;
  try {
    // Build the same draft payload the create forms POST. The occurrence would
    // carry `nextRunAt` as its issue date, so preview with that date.
    const payload = {
      clientId: p.clientId,
      currency: p.currency,
      issueDate: p.nextRunAt,
      expiryDate: p.nextRunAt,
      subject: p.subject ?? null,
      notes: p.notes ?? null,
      lineItems: p.lineItems,
    };
    const { html } = await api.post<{ html: string }>(path, payload);
    previewHtml.value = html;
  } catch {
    toastText.value = t("documents.previewError");
    toastColor.value = "info";
    toast.value = true;
    previewOpen.value = false;
  } finally {
    previewLoading.value = false;
  }
};

// ── Documents this profile has generated. ────────────────────────────────────
// Rather than listing bare ids, the card fetches the real documents so it can
// show number/date/status/total and route each row to its detail page. Every
// generated doc carries `sourceRecurringProfileId`, so one filtered list call
// per profile replaces N by-id lookups. `archived=all` keeps archived
// occurrences visible (the old id list showed them too).
interface GeneratedDoc {
  id: string;
  currency?: string | null;
  status?: string | null;
  issueDate?: string | null;
  dueDate?: string | null;
  date?: string | null;
  invoiceNumber?: string | null;
  proformaNumber?: string | null;
  expenseNumber?: string | null;
  grandTotalMinor?: number | null;
  amountMinor?: number | null;
  amountDueMinor?: number | null;
}

/** Per doc-type wiring: list endpoint, sort key, and the row's detail route. */
const generatedConfig = computed(() => {
  switch (profile.value?.documentType) {
    case "proforma":
      return { path: "/v1/proformas", sort: "-issueDate", routeName: "proforma-detail" };
    case "expense":
      // Expenses have no detail page — the edit form is the closest target.
      return { path: "/v1/expenses", sort: "-date", routeName: "expense-edit" };
    default:
      return { path: "/v1/invoices", sort: "-issueDate", routeName: "invoice-detail" };
  }
});

const generatedDocs = ref<GeneratedDoc[]>([]);
const generatedLoading = ref(false);

const loadGenerated = async (): Promise<void> => {
  const p = profile.value;
  if (!p) return;
  if (p.createdInvoiceIds.length === 0) {
    generatedDocs.value = [];
    return;
  }
  generatedLoading.value = true;
  try {
    const cfg = generatedConfig.value;
    const { data } = await api.list<GeneratedDoc>(cfg.path, {
      sourceRecurringProfileId: p.id,
      sort: cfg.sort,
      archived: "all",
      limit: 200,
    });
    generatedDocs.value = data;
  } catch (err) {
    // Non-fatal: the card degrades to its empty state rather than breaking the
    // page. Logged so a failed fetch is not indistinguishable from "none yet".
    console.warn("recurring: generated documents fetch failed", err);
    generatedDocs.value = [];
  } finally {
    generatedLoading.value = false;
  }
};

/** Document number, falling back to the draft label then a short id. */
const generatedNumber = (d: GeneratedDoc): string =>
  d.invoiceNumber ?? d.proformaNumber ?? d.expenseNumber ?? t("invoices.draftUnnumbered");

/** Issue date for invoice/proforma; `date` for expenses. */
const generatedDate = (d: GeneratedDoc): string => (d.issueDate ?? d.date ?? "").slice(0, 10) || "—";

/** Grand total for invoice/proforma; `amountMinor` for expenses. */
const generatedTotal = (d: GeneratedDoc): string =>
  minorToDisplay(d.grandTotalMinor ?? d.amountMinor, d.currency);

const openGenerated = (_e: unknown, ctx: { item: unknown }): void => {
  const row = ctx.item as GeneratedDoc;
  void router.push({ name: generatedConfig.value.routeName, params: { id: row.id } });
};

const generatedHeaders = computed(() => {
  const isExpense = profile.value?.documentType === "expense";
  return [
    { title: t("invoices.columns.number"), key: "number", sortable: false },
    { title: t("invoices.columns.status"), key: "status", sortable: false },
    { title: isExpense ? t("expenses.columns.date") : t("invoices.columns.issueDate"), key: "date", sortable: false },
    ...(isExpense ? [] : [{ title: t("invoices.columns.dueDate"), key: "dueDate", sortable: false }]),
    { title: isExpense ? t("expenses.columns.amount") : t("invoices.columns.total"), key: "total", sortable: false, align: "end" as const },
    ...(isExpense ? [] : [{ title: t("invoices.columns.due"), key: "amountDueMinor", sortable: false, align: "end" as const }]),
  ];
});

// ── Automatic email (auto-send) config ───────────────────────────────────────
// Editable from here so recipients/content can change over the profile's life.
// Only invoice/proforma can be emailed (expense has no PDF), so the control is
// hidden for expense profiles. The doc-type maps to the placeholder token set.
const autoSendDocType = computed<PlaceholderDocType>(() =>
  profile.value?.documentType === "proforma" ? "proforma" : "invoice",
);
const canAutoSend = computed<boolean>(() => profile.value?.documentType !== "expense");
const autoSendModalOpen = ref(false);
const autoSendSaving = ref(false);

const saveAutoSend = async (config: RecurringAutoSend): Promise<void> => {
  if (!profile.value) return;
  autoSendSaving.value = true;
  actionError.value = null;
  try {
    profile.value = await api.patch<RecurringProfile>(
      `/v1/recurring-profiles/${id.value}`,
      { autoSend: config },
      { ifMatch: profile.value.version },
    );
    toastText.value = t("recurring.autoSend.saved");
    toastColor.value = "success";
    toast.value = true;
  } catch (err) {
    actionError.value = err instanceof ApiError ? t("common.actionFailed", { code: apiErrorReason(err) }) : t("common.actionFailedGeneric");
  } finally {
    autoSendSaving.value = false;
  }
};

const load = async (): Promise<void> => {
  loading.value = true;
  errorMessage.value = null;
  client.value = null;
  try {
    const p = await api.get<RecurringProfile>(`/v1/recurring-profiles/${id.value}`);
    profile.value = p;
    // Generated-docs table refreshes with the profile (fire-and-forget: its own
    // failure must not blank the page).
    void loadGenerated();
    // Resolve the client to full details so the view reads like the document.
    // A missing/archived client must not fail the whole page — fall back to the
    // name cache (which also finds archived clients), never to the raw id.
    try {
      client.value = await api.get<Client>(`/v1/clients/${p.clientId}`);
    } catch {
      client.value = null;
      void resolveClientNames([p.clientId]);
    }
  } catch (err) {
    profile.value = null;
    errorMessage.value =
      err instanceof ApiError ? t("recurring.loadError", { code: apiErrorReason(err) }) : t("recurring.loadErrorGeneric");
  } finally {
    loading.value = false;
  }
};

const runAction = async (fn: () => Promise<RecurringProfile>): Promise<void> => {
  actionError.value = null;
  acting.value = true;
  try {
    profile.value = await fn();
  } catch (err) {
    actionError.value = err instanceof ApiError ? t("common.actionFailed", { code: apiErrorReason(err) }) : t("common.actionFailedGeneric");
  } finally {
    acting.value = false;
  }
};

const pause = (): void => {
  if (!profile.value) return;
  void runAction(() =>
    api.post<RecurringProfile>(`/v1/recurring-profiles/${id.value}/pause`, undefined, { ifMatch: profile.value!.version }),
  );
};
const resume = (): void => {
  if (!profile.value) return;
  void runAction(() =>
    api.post<RecurringProfile>(`/v1/recurring-profiles/${id.value}/resume`, undefined, { ifMatch: profile.value!.version }),
  );
};
const cancel = (): void => {
  if (!profile.value) return;
  void runAction(() =>
    api.post<RecurringProfile>(`/v1/recurring-profiles/${id.value}/cancel`, undefined, { ifMatch: profile.value!.version }),
  );
};

// ── Edit (active/paused profiles only — the backend rejects terminal states) ──
// Changes apply to FUTURE occurrences only; already-generated documents are
// immutable snapshots. `startDate`/`nextRunAt` stay fixed (the schedule anchor);
// cadence, bounds, template content and line items are all editable.
const canEdit = computed<boolean>(() => isActive.value || isPaused.value);
const editOpen = ref(false);
const editSaving = ref(false);
const editError = ref<string | null>(null);

const EDIT_INTERVALS: RecurringInterval[] = ["weekly", "monthly", "quarterly", "yearly"];
const editIntervalOptions = computed(() =>
  EDIT_INTERVALS.map((i) => ({ value: i, title: t(`recurring.interval.${i}`) })),
);
const editDayOptions = Array.from({ length: 31 }, (_, i) => i + 1);

const editInterval = ref<RecurringInterval>("monthly");
const editIntervalCount = ref<number>(1);
const editDayOfMonth = ref<number | null>(null);
const editEndDate = ref<string>("");
const editMaxOccurrences = ref<number | null>(null);
const editSubject = ref<string>("");
const editNotes = ref<string>("");
const editLineItems = ref<LineItemInput[]>([]);

// "Repeat on" mirrors RecurringToggle: a profile can repeat on its start day
// (dayOfMonth = null) or on a fixed day of the month. Without this selector the
// day field rendered blank for start-day profiles and looked unpopulated.
const editMonthlyMode = computed<"start" | "day">({
  get: () => (editDayOfMonth.value != null ? "day" : "start"),
  set: (mode) => {
    editDayOfMonth.value = mode === "day" ? (editDayOfMonth.value ?? startDayOfMonth.value ?? 1) : null;
  },
});

const editMonthlyModeOptions = computed(() => [
  {
    value: "start",
    // Surface the day the start date implies, e.g. "Same day as start date (15)".
    title:
      startDayOfMonth.value != null
        ? `${t("recurring.fields.repeatOnStartDay")} (${startDayOfMonth.value})`
        : t("recurring.fields.repeatOnStartDay"),
  },
  { value: "day", title: t("recurring.fields.repeatOnDayOfMonth") },
]);

/** Day-of-month implied by the profile's start date (shown on the start-day option). */
const startDayOfMonth = computed<number | null>(() => {
  const d = profile.value?.startDate;
  if (!d) return null;
  const day = Number(d.slice(8, 10));
  return Number.isFinite(day) && day >= 1 ? day : null;
});

const openEdit = (): void => {
  const p = profile.value;
  if (!p) return;
  editInterval.value = p.interval;
  editIntervalCount.value = p.intervalCount;
  editDayOfMonth.value = p.dayOfMonth ?? null;
  editEndDate.value = p.endDate ?? "";
  editMaxOccurrences.value = p.maxOccurrences ?? null;
  editSubject.value = p.subject ?? "";
  editNotes.value = p.notes ?? "";
  // Stored lines carry computed totals; the editor takes raw inputs only.
  editLineItems.value = p.lineItems.map((li) => ({
    description: li.description,
    quantity: li.quantity,
    unitPriceMinor: li.unitPriceMinor,
    ...(li.discountRate != null ? { discountRate: li.discountRate } : {}),
    ...(li.taxRate != null ? { taxRate: li.taxRate } : {}),
  }));
  editError.value = null;
  editOpen.value = true;
};

const saveEdit = async (): Promise<void> => {
  const p = profile.value;
  if (!p) return;
  editSaving.value = true;
  editError.value = null;
  try {
    profile.value = await api.patch<RecurringProfile>(
      `/v1/recurring-profiles/${id.value}`,
      {
        interval: editInterval.value,
        intervalCount: Number(editIntervalCount.value) || 1,
        dayOfMonth: editInterval.value === "weekly" ? null : editDayOfMonth.value,
        endDate: editEndDate.value.trim() || null,
        maxOccurrences:
          editMaxOccurrences.value === null || editMaxOccurrences.value === undefined
            ? null
            : Number(editMaxOccurrences.value),
        subject: editSubject.value.trim() || null,
        notes: editNotes.value.trim() || null,
        lineItems: editLineItems.value,
      },
      { ifMatch: p.version },
    );
    editOpen.value = false;
    toastText.value = t("recurring.edit.saved");
    toastColor.value = "success";
    toast.value = true;
  } catch (err) {
    editError.value =
      err instanceof ApiError ? t("common.actionFailed", { code: apiErrorReason(err) }) : t("common.actionFailedGeneric");
  } finally {
    editSaving.value = false;
  }
};

// Generate takes NO version; returns a draft payload or null when exhausted.
const generate = async (): Promise<void> => {
  if (!profile.value) return;
  actionError.value = null;
  acting.value = true;
  try {
    const payload = await api.post<InvoiceDraftPayload | null>(`/v1/recurring-profiles/${id.value}/generate`, undefined);
    if (payload) {
      toastText.value = t("recurring.generated");
      toastColor.value = "success";
    } else {
      toastText.value = t("recurring.generateExhausted");
      toastColor.value = "info";
    }
    toast.value = true;
    await load(); // refresh occurrences count / nextRunAt / status / generated docs
  } catch (err) {
    actionError.value = err instanceof ApiError ? t("common.actionFailed", { code: apiErrorReason(err) }) : t("common.actionFailedGeneric");
  } finally {
    acting.value = false;
  }
};

onMounted(() => {
  void load();
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 12px">
      <v-btn icon="mdi-arrow-left" variant="text" :aria-label="t('common.back')" @click="router.back()" />
      <h1 class="text-h5">{{ t("recurring.detailTitle") }}</h1>
    </div>

    <v-alert v-if="errorMessage" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
      {{ errorMessage }}
      <template #append>
        <v-btn color="primary" size="small" @click="load">{{ t("recurring.retry") }}</v-btn>
      </template>
    </v-alert>

    <v-card v-if="loading" variant="outlined" rounded="lg" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </v-card>

    <template v-else-if="profile">
      <v-alert v-if="actionError" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
        {{ actionError }}
      </v-alert>

      <AppCard>
        <template #header>
          <div class="text-h6 mr-3">{{ intervalLabel(profile) }}</div>
          <StatusChip :status="profile.status" />
          <v-spacer />
          <v-chip size="small" variant="tonal">{{ t(`enums.recurringDocType.${profile.documentType ?? "invoice"}`) }}</v-chip>
        </template>

        <!-- Recipient — full client details, so the profile reads like the document. -->
        <div class="text-caption mb-1">{{ t("recurring.fields.client") }}</div>
        <div v-if="client" class="mb-4">
          <div class="text-subtitle-1 font-weight-medium">
            {{ client.displayName }}
          </div>
          <div v-if="client.legalName && client.legalName !== client.displayName" class="text-body-2">
            {{ client.legalName }}
          </div>
          <div v-for="(line, i) in clientAddressLines" :key="i" class="text-body-2">{{ line }}</div>
          <div v-if="client.email" class="text-body-2">{{ client.email }}</div>
          <div v-if="client.vatNumber" class="text-body-2">
            {{ t("clients.columns.vatNumber") }}: {{ client.vatNumber }}
          </div>
        </div>
        <!-- Client could not be fully resolved (archived / deleted): show the
             cached display name (never the raw id). -->
        <div v-else class="text-body-2 mb-4" style="color: var(--v-billy-text-3)">
          {{ clientNameOf(profile.clientId) ?? "—" }}
        </div>

        <!-- Subject — part of what each occurrence carries. -->
        <template v-if="profile.subject">
          <div class="text-caption mb-1">{{ t("documents.subject") }}</div>
          <div class="text-body-1 mb-4">{{ profile.subject }}</div>
        </template>

        <v-divider class="mb-4" />

        <v-row>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("recurring.fields.currency") }}</div>{{ profile.currency }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("recurring.fields.startDate") }}</div>{{ profile.startDate }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("recurring.columns.nextRun") }}</div>{{ profile.nextRunAt }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("recurring.fields.endDate") }}</div>{{ profile.endDate ?? "—" }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("recurring.fields.maxOccurrences") }}</div>{{ profile.maxOccurrences ?? "—" }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("recurring.occurrences") }}</div>{{ profile.occurrencesGenerated }}</v-col>
          <v-col cols="6" md="3"><div class="text-caption">{{ t("recurring.lastRun") }}</div>{{ profile.lastRunAt ?? "—" }}</v-col>
        </v-row>

        <template #actions>
          <div class="d-flex align-center" style="gap: 8px; flex-wrap: wrap; width: 100%">
            <v-btn v-if="canPreview" variant="tonal" color="info" prepend-icon="mdi-eye-outline" :loading="previewLoading" @click="preview">
              {{ t("documents.preview") }}
            </v-btn>
            <v-spacer />
            <v-btn
              v-if="canEdit"
              color="primary"
              variant="tonal"
              prepend-icon="mdi-pencil"
              :loading="acting"
              data-test="recurring-edit"
              @click="openEdit"
            >
              {{ t("common.edit") }}
            </v-btn>
            <v-btn v-if="canGenerate" color="primary" :loading="acting" prepend-icon="mdi-play" @click="generate">
              {{ t("recurring.generateNow") }}
            </v-btn>
            <v-btn v-if="isActive" color="primary" :loading="acting" @click="pause">
              {{ t("recurring.pause") }}
            </v-btn>
            <v-btn v-if="isPaused" color="primary" :loading="acting" @click="resume">
              {{ t("recurring.resume") }}
            </v-btn>
            <v-btn v-if="canCancel" color="error" :loading="acting" @click="cancel">
              {{ t("recurring.cancel") }}
            </v-btn>
          </div>
        </template>
      </AppCard>

      <v-card variant="outlined" rounded="lg" class="mb-4">
        <v-card-text>
        <div class="text-subtitle-2 mb-2">{{ t("recurring.lineItems") }}</div>
        <v-table density="compact">
          <thead>
            <tr>
              <th>{{ t("recurring.lineCols.description") }}</th>
              <th class="text-right">{{ t("recurring.lineCols.qty") }}</th>
              <th class="text-right">{{ t("recurring.lineCols.unit") }}</th>
              <th class="text-right">{{ t("recurring.lineCols.total") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(li, i) in profile.lineItems" :key="i">
              <td style="white-space: pre-line">{{ li.description }}</td>
              <td class="text-right">{{ li.quantity }}</td>
              <td class="text-right">{{ minorToDisplay(li.unitPriceMinor, profile.currency) }}</td>
              <td class="text-right">{{ minorToDisplay(li.lineTotalMinor, profile.currency) }}</td>
            </tr>
          </tbody>
        </v-table>
        <v-divider class="my-3" />
        <div class="d-flex justify-end">
          <div style="min-width: 240px">
            <div class="d-flex justify-space-between">
              <span>{{ t("recurring.totals.subtotal") }}</span><span>{{ minorToDisplay(profile.subtotalMinor, profile.currency) }}</span>
            </div>
            <div class="d-flex justify-space-between">
              <span>{{ t("recurring.totals.tax") }}</span><span>{{ minorToDisplay(profile.taxMinor, profile.currency) }}</span>
            </div>
            <div class="d-flex justify-space-between text-subtitle-1 font-weight-medium">
              <span>{{ t("recurring.totals.total") }}</span><span>{{ minorToDisplay(profile.grandTotalMinor, profile.currency) }}</span>
            </div>
          </div>
        </div>
        </v-card-text>
      </v-card>

      <!-- Automatic email (auto-send). Editable here so recipients/content can change
           over the profile's life. Hidden for expense (no PDF to email). -->
      <v-card v-if="canAutoSend" variant="outlined" rounded="lg" class="mb-4">
        <v-card-text class="d-flex align-center" style="gap: 12px">
          <v-icon :icon="profile.autoSend?.enabled ? 'mdi-email-check-outline' : 'mdi-email-off-outline'" :color="profile.autoSend?.enabled ? 'success' : undefined" />
          <div>
            <div class="text-subtitle-2">{{ t("recurring.autoSend.title") }}</div>
            <div class="text-body-2" style="color: var(--v-billy-text-3)">
              {{ profile.autoSend?.enabled ? t("recurring.autoSend.statusOn", { to: profile.autoSend?.to ?? "" }) : t("recurring.autoSend.statusOff") }}
            </div>
          </div>
          <v-spacer />
          <v-btn variant="tonal" color="primary" prepend-icon="mdi-cog-outline" @click="autoSendModalOpen = true">
            {{ t("recurring.autoSend.configure") }}
          </v-btn>
        </v-card-text>
      </v-card>

      <!-- Documents already generated from this profile (createdInvoiceIds). -->
      <v-card variant="outlined" rounded="lg" class="mb-4">
        <v-card-text>
          <div class="text-subtitle-2 mb-2">{{ t("recurring.generatedDocs") }}</div>
          <div v-if="profile.createdInvoiceIds.length === 0" class="text-body-2" style="color: var(--v-billy-text-3)">
            {{ t("recurring.generatedNone") }}
          </div>
          <v-data-table
            v-else
            :headers="generatedHeaders"
            :items="generatedDocs"
            :loading="generatedLoading"
            density="compact"
            hover
            items-per-page="-1"
            hide-default-footer
            class="billy-clickable-rows"
            @click:row="openGenerated"
          >
            <template #[`item.number`]="{ item }">
              {{ generatedNumber(item) }}
            </template>
            <template #[`item.status`]="{ item }">
              <StatusChip v-if="item.status" :status="item.status" />
              <span v-else>—</span>
            </template>
            <template #[`item.date`]="{ item }">
              {{ generatedDate(item) }}
            </template>
            <template #[`item.dueDate`]="{ item }">
              {{ (item.dueDate ?? "").slice(0, 10) || "—" }}
            </template>
            <template #[`item.total`]="{ item }">
              {{ generatedTotal(item) }}
            </template>
            <template #[`item.amountDueMinor`]="{ item }">
              {{ minorToDisplay(item.amountDueMinor, item.currency) }}
            </template>
            <!-- Reached only when the fetch failed (the ids exist but no docs
                 came back); keeps the card explicable instead of blank. -->
            <template #no-data>
              <div class="text-body-2 py-2" style="color: var(--v-billy-text-3)">
                {{ t("tables.no_results") }}
              </div>
            </template>
          </v-data-table>
        </v-card-text>
      </v-card>
    </template>

    <!-- Edit dialog — changes apply to FUTURE occurrences only. -->
    <v-dialog v-model="editOpen" max-width="1280" width="92vw" scrollable>
      <v-card variant="outlined" rounded="lg">
        <v-card-title class="d-flex align-center">
          <span>{{ t("recurring.edit.title") }}</span>
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" size="small" :aria-label="t('common.cancel')" @click="editOpen = false" />
        </v-card-title>
        <v-divider />
        <v-card-text style="max-height: 76vh">
          <v-alert v-if="editError" type="error" variant="tonal" density="compact" class="mb-4" role="alert">
            {{ editError }}
          </v-alert>
          <div class="text-caption text-medium-emphasis mb-3">{{ t("recurring.edit.hint") }}</div>
          <v-row>
            <v-col cols="12" md="4">
              <v-select
                v-model="editInterval"
                :items="editIntervalOptions"
                :label="t('recurring.fields.interval')"
                density="comfortable"
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field
                v-model.number="editIntervalCount"
                :label="t('recurring.fields.intervalCount')"
                type="number"
                min="1"
                density="comfortable"
              />
            </v-col>
            <v-col v-if="editInterval !== 'weekly'" cols="12" md="4">
              <v-select
                v-model="editMonthlyMode"
                :items="editMonthlyModeOptions"
                :label="t('recurring.fields.repeatOn')"
                density="comfortable"
              />
            </v-col>
            <v-col v-if="editInterval !== 'weekly' && editMonthlyMode === 'day'" cols="12" md="4">
              <v-select
                v-model.number="editDayOfMonth"
                :items="editDayOptions"
                :label="t('recurring.fields.dayOfMonth')"
                :hint="t('recurring.fields.dayOfMonthHint')"
                persistent-hint
                density="comfortable"
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field
                v-model="editEndDate"
                :label="t('recurring.fields.endDate')"
                type="date"
                density="comfortable"
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field
                v-model.number="editMaxOccurrences"
                :label="t('recurring.fields.maxOccurrences')"
                type="number"
                min="1"
                clearable
                density="comfortable"
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field
                v-model="editSubject"
                :label="t('documents.subject')"
                density="comfortable"
              />
            </v-col>
          </v-row>

          <LineItemEditor
            v-if="profile"
            v-model="editLineItems"
            :currency="profile.currency"
            :doc-type="autoSendDocType"
          />

          <v-textarea
            v-model="editNotes"
            :label="t('recurring.fields.notes')"
            rows="2"
            auto-grow
            density="comfortable"
            class="mt-4"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="editOpen = false">{{ t("common.cancel") }}</v-btn>
          <v-btn color="primary" data-test="recurring-edit-save" :loading="editSaving" @click="saveEdit">
            {{ t("common.saveChanges") }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <DocumentPreviewDialog v-model="previewOpen" :html="previewHtml" :loading="previewLoading" />

    <AutoSendConfigModal
      v-if="profile"
      v-model="autoSendModalOpen"
      :doc-type="autoSendDocType"
      :config="profile.autoSend ?? null"
      :profile-id="id"
      :saving="autoSendSaving"
      @save="saveAutoSend"
    />

    <v-snackbar v-model="toast" :color="toastColor" :timeout="4000">
      {{ toastText }}
    </v-snackbar>
  </div>
</template>

<style scoped>
/* Generated-documents table: rows navigate to the document on click. */
.billy-clickable-rows :deep(tbody tr) {
  cursor: pointer;
}
</style>
