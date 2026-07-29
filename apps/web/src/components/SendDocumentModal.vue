<script setup lang="ts">
/**
 * SendDocumentModal — reusable "email this document" dialog, DRY across invoices
 * and contracts (and the invoice/reminder resend variants via the `kind` prop).
 * Flat theme: outlined card, no shadow, matching the house dialog style.
 *
 * On open it loads the server-rendered default email
 * (GET .../send/preview?kind=…) and pre-fills:
 *   - To      (default from the response's `to`)
 *   - CC / BCC (chip multi-email combobox inputs, empty by default)
 *   - Subject (default from the response's `subject`)
 *   - Body    (editable RichTextEditor, default from the response's `html`)
 * A note reminds the user the document PDF will be attached.
 *
 * On submit it POSTs .../send with { to, cc, bcc, subject, body, kind } and the
 * If-Match `version` guard, then reacts to the TWO backend response shapes:
 *   • queued  → success snackbar, close.
 *   • pending → info snackbar (PDF still rendering), keep the modal open so the
 *               user can retry Send in a few seconds.
 *   • error   → error snackbar (covers 503 QUEUE_UNAVAILABLE + everything else).
 *
 * The heavy lifting lives in useSendDocument (mirrors useDocumentActions).
 */
import { ref, computed, watch, toRef } from "vue";
import { useI18n } from "vue-i18n";
import type { PlaceholderDocType } from "@billy/shared/template";
import RichTextEditor from "@/components/RichTextEditor.vue";
import PlaceholderLegend from "@/components/PlaceholderLegend.vue";
import PlaceholderInsertMenu from "@/components/PlaceholderInsertMenu.vue";
import { usePlaceholderInsert } from "@/composables/usePlaceholderInsert";
import {
  useSendDocument,
  type SendDocumentType,
  type SendKind,
} from "@/composables/useSendDocument";
import AttachmentsField, { type Attachment } from "@/components/AttachmentsField.vue";

// The document PDF is added server-side and its size is unknown until generated;
// reserve ~1 MB against the 20 MB budget as a safe estimate. The API enforces the
// REAL combined total and rejects an over-budget send.
const DOC_PDF_RESERVE_BYTES = 1024 * 1024;

const props = withDefaults(
  defineProps<{
    /** Two-way open state (`v-model`). */
    modelValue: boolean;
    documentType: SendDocumentType;
    documentId: string;
    kind?: SendKind;
    /** Optimistic-concurrency version → If-Match on the POST. */
    version?: number;
  }>(),
  { kind: "invoice", version: undefined },
);

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  /** Emitted once the email is successfully queued (lets parents refresh/navigate). */
  sent: [];
}>();

const { t } = useI18n();

// Placeholder insert: the send doc-type (invoice|contract) is a PlaceholderDocType,
// so the subject legend + body {{ }} toolbar offer the tokens valid for this document.
const placeholderDocType = computed<PlaceholderDocType>(() => props.documentType);
const { onContextMenu, menuState, insertToken } = usePlaceholderInsert();

const typeRef = toRef(props, "documentType");
const idRef = toRef(props, "documentId");
const { previewLoading, sending, loadError, loadPreview, send } = useSendDocument(
  () => typeRef.value,
  () => idRef.value,
);

const open = computed<boolean>({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});

// Form state (reset + re-seeded from the preview each time the modal opens).
const to = ref("");
const cc = ref<string[]>([]);
const bcc = ref<string[]>([]);
const subject = ref("");
const body = ref("");
// User-added attachments (sent ALONGSIDE the document PDF). Reset each open.
const attachments = ref<Attachment[]>([]);
// Read-receipt: adds a Disposition-Notification-To header (value = reply-to, or
// the From address if none). Off by default; reset each time the modal opens.
const requestReadReceipt = ref(false);
// BCC the company's own email (business settings) so the sender keeps a copy.
const copyToCompany = ref(false);

// Snackbar state — success (queued), info (pending PDF), error (send failed).
const successOpen = ref(false);
const pendingOpen = ref(false);
const errorCode = ref<string | null>(null);

const prime = async (): Promise<void> => {
  errorCode.value = null;
  const preview = await loadPreview(props.kind);
  if (!preview) return;
  to.value = preview.to ?? "";
  cc.value = [];
  bcc.value = [];
  subject.value = preview.subject ?? "";
  body.value = preview.html ?? "";
  requestReadReceipt.value = false;
  copyToCompany.value = false;
  attachments.value = [];
};

watch(
  () => [props.modelValue, props.kind] as const,
  ([isOpen], prev) => {
    // Prime when the modal is open — on the open transition, on a kind change
    // while open, and on initial mount if it mounts already-open (immediate).
    const wasOpen = prev?.[0] ?? false;
    if (isOpen && (!wasOpen || props.kind !== prev?.[1])) void prime();
  },
  { immediate: true },
);

const submit = async (): Promise<void> => {
  errorCode.value = null;
  const outcome = await send(
    {
      to: to.value.trim(),
      cc: cc.value,
      bcc: bcc.value,
      subject: subject.value,
      body: body.value,
      kind: props.kind,
      requestReadReceipt: requestReadReceipt.value,
      copyToCompany: copyToCompany.value,
      attachmentFileIds: attachments.value.map((a) => a.fileId),
    },
    props.version,
  );
  if (outcome.kind === "queued") {
    successOpen.value = true;
    open.value = false;
    emit("sent");
  } else if (outcome.kind === "pending") {
    // PDF still rendering — nothing was emailed. Keep the modal open so the user
    // can retry Send in a few seconds.
    pendingOpen.value = true;
  } else {
    errorCode.value = outcome.code;
  }
};

const attachmentNote = computed(() =>
  props.documentType === "contract"
    ? t("send.attachmentNoteContract")
    : t("send.attachmentNoteInvoice"),
);
const title = computed(() =>
  props.kind === "reminder" ? t("send.titleReminder") : t("send.title"),
);
</script>

<template>
  <v-dialog v-model="open" max-width="720" scrollable>
    <v-card variant="outlined" rounded="lg">
      <v-card-title class="d-flex align-center">
        <span>{{ title }}</span>
        <v-spacer />
        <v-btn
          icon="mdi-close"
          variant="text"
          size="small"
          :aria-label="t('common.cancel')"
          @click="open = false"
        />
      </v-card-title>
      <v-divider />

      <v-card-text style="max-height: 72vh">
        <div v-if="previewLoading" class="pa-8 text-center">
          <v-progress-circular indeterminate />
        </div>

        <template v-else>
          <v-alert
            v-if="loadError"
            type="error"
            variant="tonal"
            density="compact"
            class="mb-4"
            role="alert"
          >
            {{ t("send.loadError", { code: loadError }) }}
            <template #append>
              <v-btn color="primary" size="small" @click="prime">{{ t("common.retry") }}</v-btn>
            </template>
          </v-alert>

          <v-alert
            v-if="errorCode"
            type="error"
            variant="tonal"
            density="compact"
            class="mb-4"
            role="alert"
          >
            {{ t("send.error", { code: errorCode }) }}
          </v-alert>

          <v-text-field
            v-model="to"
            data-test="send-to"
            :label="t('send.to')"
            type="email"
            density="comfortable"
          />
          <v-combobox
            v-model="cc"
            data-test="send-cc"
            :label="t('send.cc')"
            :placeholder="t('send.emailPlaceholder')"
            multiple
            chips
            closable-chips
            clearable
            density="comfortable"
          />
          <v-combobox
            v-model="bcc"
            data-test="send-bcc"
            :label="t('send.bcc')"
            :placeholder="t('send.emailPlaceholder')"
            multiple
            chips
            closable-chips
            clearable
            density="comfortable"
          />
          <v-text-field
            v-model="subject"
            data-test="send-subject"
            :label="t('send.subject')"
            density="comfortable"
            class="placeholder-field"
            @contextmenu="onContextMenu"
          >
            <template #append-inner>
              <PlaceholderLegend :doc-type="placeholderDocType" />
            </template>
          </v-text-field>
          <RichTextEditor v-model="body" :label="t('send.body')" :doc-type="placeholderDocType" />
          <PlaceholderInsertMenu :state="menuState" :doc-type="placeholderDocType" @insert="insertToken" />

          <v-switch
            v-model="requestReadReceipt"
            data-test="send-read-receipt"
            color="primary"
            density="compact"
            hide-details
            class="mt-2"
            :label="t('send.readReceipt')"
          />
          <div class="text-caption text-medium-emphasis mb-2">{{ t("send.readReceiptHint") }}</div>

          <v-switch
            v-model="copyToCompany"
            data-test="send-copy-to-company"
            color="primary"
            density="compact"
            hide-details
            :label="t('send.copyToCompany')"
          />
          <div class="text-caption text-medium-emphasis mb-2">{{ t("send.copyToCompanyHint") }}</div>

          <v-alert
            type="info"
            variant="tonal"
            density="compact"
            class="mt-4"
            icon="mdi-paperclip"
          >
            {{ attachmentNote }}
          </v-alert>

          <!-- Extra attachments (sent alongside the document PDF). The doc PDF's real
               size is unknown until generated, so reserve ~1 MB against the 20 MB
               budget; the server enforces the true combined total. -->
          <AttachmentsField v-model="attachments" :reserved-bytes="DOC_PDF_RESERVE_BYTES" class="mt-4" />
        </template>
      </v-card-text>

      <!-- .v-card-actions already has a top border (styles/app.scss); no divider. -->
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="open = false">{{ t("common.cancel") }}</v-btn>
        <v-btn
          color="primary"
          data-test="send-submit"
          :loading="sending"
          :disabled="previewLoading"
          @click="submit"
        >
          {{ t("send.send") }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-snackbar v-model="successOpen" color="success" :timeout="4000">
    {{ t("send.queued") }}
  </v-snackbar>
  <v-snackbar v-model="pendingOpen" color="info" :timeout="6000">
    {{ t("send.pending") }}
  </v-snackbar>
</template>
