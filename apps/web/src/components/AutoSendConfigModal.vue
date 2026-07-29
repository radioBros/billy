<script setup lang="ts">
/**
 * AutoSendConfigModal — configure a recurring profile's per-occurrence auto-send
 * email. It deliberately mirrors SendDocumentModal's field layout (To / CC / BCC /
 * Subject / Body + the {{ }} placeholder insert UI) so configuring auto-send feels
 * exactly like the real send popup — but it edits a STORED template rather than
 * sending, so it has no document id, no PDF preview, and no attachments.
 *
 * KEY DIFFERENCE from the send popup: fields are primed RAW from the stored config
 * (no placeholder resolution). The tokens must stay literal so every future
 * occurrence resolves them against its OWN dates/number/client at send time.
 *
 * Gated by an `enabled` switch. When ON, To / Subject / Body are REQUIRED (mirrors
 * the backend `refineAutoSend`); Save is blocked until they're filled. When OFF the
 * fields are hidden and Save stores `{ enabled: false }`.
 *
 * v-model: open state. v-model:config: the RecurringAutoSend being edited. `save`
 * is emitted with the assembled config for the parent to persist.
 */
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { PlaceholderDocType } from "@billy/shared/template";
import type { RecurringAutoSend } from "@/types/domain";
import { autoSendDefaultTemplate } from "@/constants/autoSendDefaults";
import RichTextEditor from "@/components/RichTextEditor.vue";
import PlaceholderLegend from "@/components/PlaceholderLegend.vue";
import PlaceholderInsertMenu from "@/components/PlaceholderInsertMenu.vue";
import AttachmentsField, { type Attachment } from "@/components/AttachmentsField.vue";
import { usePlaceholderInsert, DATE_EXAMPLE_PARAMS } from "@/composables/usePlaceholderInsert";

const props = defineProps<{
  /** Two-way open state (`v-model`). */
  modelValue: boolean;
  /** The doc family the profile generates — drives which placeholder tokens show. */
  docType: PlaceholderDocType;
  /** The current stored config (null ⇒ never configured). */
  config: RecurringAutoSend | null;
  /** The profile id — extra attachments are uploaded owned by this profile so they
   *  are deleted when the profile is deleted. OMIT at create time (no profile yet):
   *  the attachments section is hidden and can be added later from the detail page. */
  profileId?: string | null;
  /** Default recipient (the selected client's email) prefilled when the stored
   *  config has no `to` yet. */
  defaultTo?: string | null;
  /** Open with the enabled switch already ON (create-flow: the user just flipped
   *  the auto-send switch and is here to configure it). */
  initialEnabled?: boolean;
  /** Disable while the parent is saving. */
  saving?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  /** Emitted with the assembled config when the user saves. */
  save: [config: RecurringAutoSend];
}>();

const { t, locale } = useI18n();

const { onContextMenu, menuState, insertToken } = usePlaceholderInsert();

const open = computed<boolean>({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});

// Local editable state, (re)seeded from the stored config each time the modal opens.
const enabled = ref(false);
const to = ref("");
const cc = ref<string[]>([]);
const bcc = ref<string[]>([]);
const subject = ref("");
const body = ref("");
const requestReadReceipt = ref(false);
const copyToCompany = ref(false);
const showErrors = ref(false);
// Files added this session (rich rows). Persisted ids not added this session are
// kept separately as `savedFileIds` and shown as removable chips.
const newAttachments = ref<Attachment[]>([]);
const savedFileIds = ref<string[]>([]);

const prime = (): void => {
  const c = props.config;
  enabled.value = c?.enabled ?? props.initialEnabled ?? false;
  // Never-configured fields get sensible defaults: the selected client's email
  // as recipient, and a placeholder template ({{document.number}}, {{total}},
  // dates…) as subject/body — stored RAW so each occurrence resolves its own
  // values at send time.
  const defaults = autoSendDefaultTemplate(props.docType, String(locale.value));
  to.value = c?.to ?? props.defaultTo ?? "";
  cc.value = c?.cc ?? [];
  bcc.value = c?.bcc ?? [];
  subject.value = c?.subject ?? defaults.subject;
  body.value = c?.body ?? defaults.body; // RAW — placeholders stay literal on purpose.
  requestReadReceipt.value = c?.requestReadReceipt ?? false;
  copyToCompany.value = c?.copyToCompany ?? false;
  newAttachments.value = [];
  savedFileIds.value = [...(c?.attachmentFileIds ?? [])];
  showErrors.value = false;
};

/** All attachment ids to persist: previously-saved (kept) + newly-uploaded. */
const allFileIds = computed<string[]>(() => [...savedFileIds.value, ...newAttachments.value.map((a) => a.fileId)]);
const removeSaved = (fileId: string): void => {
  savedFileIds.value = savedFileIds.value.filter((f) => f !== fileId);
};

watch(
  () => props.modelValue,
  (isOpen, was) => {
    if (isOpen && !was) prime();
  },
  { immediate: true },
);

// When enabled, To / Subject / Body are mandatory (mirrors the backend).
const missingTo = computed(() => enabled.value && to.value.trim().length === 0);
const missingSubject = computed(() => enabled.value && subject.value.trim().length === 0);
const missingBody = computed(() => enabled.value && body.value.trim().length === 0);
const invalid = computed(() => missingTo.value || missingSubject.value || missingBody.value);

const submit = (): void => {
  if (!enabled.value) {
    emit("save", { enabled: false });
    open.value = false;
    return;
  }
  showErrors.value = true;
  if (invalid.value) return;
  emit("save", {
    enabled: true,
    to: to.value.trim(),
    cc: cc.value,
    bcc: bcc.value,
    subject: subject.value.trim(),
    body: body.value,
    requestReadReceipt: requestReadReceipt.value,
    copyToCompany: copyToCompany.value,
    attachmentFileIds: allFileIds.value,
  });
  open.value = false;
};
</script>

<template>
  <v-dialog v-model="open" max-width="720" scrollable>
    <v-card variant="outlined" rounded="lg">
      <v-card-title class="d-flex align-center">
        <span>{{ t("recurring.autoSend.title") }}</span>
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" size="small" :aria-label="t('common.cancel')" @click="open = false" />
      </v-card-title>
      <v-divider />

      <v-card-text style="max-height: 72vh">
        <v-switch
          v-model="enabled"
          data-test="autosend-enabled"
          color="primary"
          hide-details
          :label="t('recurring.autoSend.enable')"
        />
        <div class="text-caption text-medium-emphasis mb-3">{{ t("recurring.autoSend.hint") }}</div>

        <template v-if="enabled">
          <v-text-field
            v-model="to"
            data-test="autosend-to"
            :label="t('send.to')"
            type="email"
            density="comfortable"
            :error="showErrors && missingTo"
            :error-messages="showErrors && missingTo ? t('common.required') : undefined"
          />
          <v-combobox
            v-model="cc"
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
            data-test="autosend-subject"
            :label="t('send.subject')"
            density="comfortable"
            class="placeholder-field"
            :error="showErrors && missingSubject"
            :error-messages="showErrors && missingSubject ? t('common.required') : undefined"
            @contextmenu="onContextMenu"
          >
            <template #append-inner>
              <PlaceholderLegend :doc-type="docType" />
            </template>
          </v-text-field>
          <RichTextEditor v-model="body" :label="t('send.body')" :doc-type="docType" />
          <div v-if="showErrors && missingBody" class="text-caption text-error mt-1">{{ t("common.required") }}</div>
          <PlaceholderInsertMenu :state="menuState" :doc-type="docType" @insert="insertToken" />

          <v-switch
            v-model="requestReadReceipt"
            color="primary"
            density="compact"
            hide-details
            class="mt-2"
            :label="t('send.readReceipt')"
          />

          <v-switch
            v-model="copyToCompany"
            data-test="autosend-copy-to-company"
            color="primary"
            density="compact"
            hide-details
            :label="t('send.copyToCompany')"
          />
          <div class="text-caption text-medium-emphasis">{{ t("send.copyToCompanyHint") }}</div>

          <v-alert type="info" variant="tonal" density="compact" class="mt-4" icon="mdi-information-outline">
            {{ t("recurring.autoSend.placeholderNote", DATE_EXAMPLE_PARAMS) }}
          </v-alert>

          <!-- Extra static attachments sent with EVERY occurrence (alongside its PDF).
               Uploaded owned by this profile so they are deleted with it. Hidden at
               CREATE time (no profile id to own the upload yet) — attachments can be
               added later from the profile's detail page. -->
          <template v-if="profileId">
            <div class="text-subtitle-2 mt-4 mb-1">{{ t("recurring.autoSend.attachments") }}</div>
            <div class="text-caption text-medium-emphasis mb-2">{{ t("recurring.autoSend.attachmentsHint") }}</div>
            <!-- Previously-saved attachments (only ids are stored) shown as removable chips. -->
            <div v-if="savedFileIds.length > 0" class="d-flex flex-wrap mb-2" style="gap: 6px">
              <v-chip
                v-for="fid in savedFileIds"
                :key="fid"
                closable
                size="small"
                prepend-icon="mdi-paperclip"
                @click:close="removeSaved(fid)"
              >
                {{ t("recurring.autoSend.savedAttachment") }}
              </v-chip>
            </div>
            <AttachmentsField
              v-model="newAttachments"
              owner-type="recurring-profile"
              :owner-id="profileId"
            />
          </template>
        </template>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="open = false">{{ t("common.cancel") }}</v-btn>
        <v-btn color="primary" data-test="autosend-save" :loading="saving" @click="submit">
          {{ t("common.saveChanges") }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
