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
import RichTextEditor from "@/components/RichTextEditor.vue";
import {
  useSendDocument,
  type SendDocumentType,
  type SendKind,
} from "@/composables/useSendDocument";

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
              <v-btn variant="text" size="small" @click="prime">{{ t("common.retry") }}</v-btn>
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
          />
          <RichTextEditor v-model="body" :label="t('send.body')" />

          <v-alert
            type="info"
            variant="tonal"
            density="compact"
            class="mt-4"
            icon="mdi-paperclip"
          >
            {{ attachmentNote }}
          </v-alert>
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
