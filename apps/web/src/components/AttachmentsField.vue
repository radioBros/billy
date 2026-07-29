<script setup lang="ts">
/**
 * AttachmentsField — a reusable file-attachment picker for outgoing emails.
 *
 * v-model is the attachments array; each item is
 * `{ fileId, filename, sizeBytes, contentType }`. Files are uploaded same-origin
 * through `uploadFile` (which streams the bytes via our API); the returned fileId
 * is stored in the list. Image rows preview inline with ImageZoom; PDF rows open a
 * small dialog with an `<iframe>` pointing at the file's `/content` URL (the API
 * serves image/* and application/pdf `inline`, so the iframe renders rather than
 * downloads). Other types show no preview.
 *
 * A running budget (sum of item sizes + `reservedBytes`) is checked BEFORE each
 * upload; a file that would bust `maxTotalBytes` is skipped with a toast, never
 * uploaded. Selected files are processed sequentially so the budget accumulates
 * within a single batch (three big files can't each individually pass a stale sum).
 */
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import ImageZoom from "@/components/ImageZoom.vue";
import { uploadFile, logoUrlFor } from "@/api/files";
import { useToast } from "@/composables/useToast";

export interface Attachment {
  fileId: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
}

const props = withDefaults(
  defineProps<{
    modelValue: Attachment[];
    maxTotalBytes?: number;
    reservedBytes?: number;
    accept?: string;
    disabled?: boolean;
    /** Owner the uploaded files are stored under. Defaults to the transient
     *  "email-attachment" owner used by the one-off send popup. The recurring
     *  auto-send config passes "recurring-profile"/<profileId> so the files are
     *  owned by the profile and deleted with it. */
    ownerType?: string;
    ownerId?: string;
  }>(),
  {
    maxTotalBytes: 20 * 1024 * 1024,
    reservedBytes: 0,
    accept: "image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt",
    disabled: false,
    ownerType: "email-attachment",
    ownerId: "email-attachment",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: Attachment[]];
}>();

const { t } = useI18n();
const { toast } = useToast();

const fileInput = ref<HTMLInputElement | null>(null);
const dragActive = ref(false);
/** filenames currently mid-upload — drives the per-file spinner + a global busy flag. */
const uploading = ref<string[]>([]);

const pdfPreview = ref<Attachment | null>(null);

// ── budget ────────────────────────────────────────────────────────────────
const usedBytes = computed(() =>
  props.modelValue.reduce((sum, a) => sum + a.sizeBytes, 0) + props.reservedBytes,
);
const overBudget = computed(() => usedBytes.value > props.maxTotalBytes);
const nearBudget = computed(
  () => !overBudget.value && usedBytes.value >= props.maxTotalBytes * 0.9,
);
const budgetColor = computed(() =>
  overBudget.value ? "error" : nearBudget.value ? "warning" : undefined,
);
const budgetText = computed(() => {
  const params = { used: formatBytes(usedBytes.value), max: formatBytes(props.maxTotalBytes) };
  return props.reservedBytes > 0 ? t("attachments.budgetWithDoc", params) : t("attachments.budget", params);
});

// ── formatting ──────────────────────────────────────────────────────────────
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function iconFor(contentType: string): string {
  if (contentType.startsWith("image/")) return "mdi-file-image";
  if (contentType === "application/pdf") return "mdi-file-pdf-box";
  return "mdi-file";
}

const isImage = (a: Attachment): boolean => a.contentType.startsWith("image/");
const isPdf = (a: Attachment): boolean => a.contentType === "application/pdf";

// ── add / upload ──────────────────────────────────────────────────────────
function openPicker(): void {
  if (props.disabled) return;
  fileInput.value?.click();
}

function onInputChange(e: Event): void {
  const input = e.target as HTMLInputElement;
  const files = input.files ? Array.from(input.files) : [];
  void handleFiles(files);
  // reset so selecting the same file again re-fires change
  input.value = "";
}

function onDrop(e: DragEvent): void {
  dragActive.value = false;
  if (props.disabled) return;
  const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
  void handleFiles(files);
}

/**
 * Upload the selected files one at a time so the budget check for file N sees the
 * accepted sizes of files 1…N-1. Files that would bust the budget are skipped with
 * a toast; the rest upload.
 */
async function handleFiles(files: File[]): Promise<void> {
  for (const file of files) {
    const projected = usedBytes.value + file.size;
    if (projected > props.maxTotalBytes) {
      toast.error(
        t("attachments.tooLarge", { name: file.name, max: formatBytes(props.maxTotalBytes) }),
      );
      continue;
    }

    uploading.value.push(file.name);
    try {
      const fileId = await uploadFile(file, {
        ownerType: props.ownerType,
        ownerId: props.ownerId,
      });
      const next: Attachment[] = [
        ...props.modelValue,
        {
          fileId,
          filename: file.name,
          sizeBytes: file.size,
          contentType: file.type || "application/octet-stream",
        },
      ];
      emit("update:modelValue", next);
    } catch {
      toast.error(t("attachments.uploadError", { name: file.name }));
    } finally {
      const i = uploading.value.indexOf(file.name);
      if (i !== -1) uploading.value.splice(i, 1);
    }
  }
}

function remove(index: number): void {
  if (props.disabled) return;
  const next = props.modelValue.filter((_, i) => i !== index);
  emit("update:modelValue", next);
}

function openPreview(a: Attachment): void {
  if (isPdf(a)) pdfPreview.value = a;
}

// expose for template
const src = logoUrlFor;
</script>

<template>
  <div class="attachments-field">
    <!-- Hidden native input; the drop zone / button drives it. -->
    <input
      ref="fileInput"
      type="file"
      multiple
      :accept="accept"
      class="attachments-field__input"
      @change="onInputChange"
    />

    <!-- Drop zone -->
    <div
      class="attachments-field__zone"
      :class="{
        'attachments-field__zone--active': dragActive,
        'attachments-field__zone--disabled': disabled,
      }"
      role="button"
      tabindex="0"
      @click="openPicker"
      @keydown.enter.prevent="openPicker"
      @keydown.space.prevent="openPicker"
      @dragover.prevent="!disabled && (dragActive = true)"
      @dragleave.prevent="dragActive = false"
      @drop.prevent="onDrop"
    >
      <v-icon icon="mdi-paperclip" size="24" class="mb-1" />
      <div class="text-body-2">{{ t("attachments.dropHint") }}</div>
      <v-btn
        class="mt-2"
        size="small"
        variant="tonal"
        prepend-icon="mdi-plus"
        :disabled="disabled"
        @click.stop="openPicker"
      >
        {{ t("attachments.add") }}
      </v-btn>
    </div>

    <!-- Attachment rows -->
    <v-list v-if="modelValue.length || uploading.length" density="compact" class="attachments-field__list mt-2">
      <v-list-item
        v-for="(item, index) in modelValue"
        :key="item.fileId"
        class="attachments-field__row px-2"
      >
        <template #prepend>
          <ImageZoom
            v-if="isImage(item)"
            :src="src(item.fileId)"
            :alt="item.filename"
            :max-height="40"
            :max-width="56"
            class="mr-3"
          />
          <v-icon v-else :icon="iconFor(item.contentType)" size="28" class="mr-3" />
        </template>

        <v-list-item-title
          class="attachments-field__name"
          :class="{ 'attachments-field__name--link': isPdf(item) }"
          @click="openPreview(item)"
        >
          {{ item.filename }}
        </v-list-item-title>
        <v-list-item-subtitle>{{ formatBytes(item.sizeBytes) }}</v-list-item-subtitle>

        <template #append>
          <v-btn
            v-if="isPdf(item)"
            icon="mdi-eye-outline"
            variant="text"
            size="small"
            :aria-label="t('attachments.previewPdf')"
            :title="t('attachments.previewPdf')"
            @click="openPreview(item)"
          />
          <v-btn
            icon="mdi-close"
            variant="text"
            size="small"
            color="error"
            :disabled="disabled"
            :aria-label="t('attachments.remove')"
            :title="t('attachments.remove')"
            @click="remove(index)"
          />
        </template>
      </v-list-item>

      <!-- In-flight uploads -->
      <v-list-item v-for="name in uploading" :key="`up-${name}`" class="px-2">
        <template #prepend>
          <v-progress-circular indeterminate size="20" width="2" class="mr-3" />
        </template>
        <v-list-item-title class="attachments-field__name">{{ name }}</v-list-item-title>
      </v-list-item>
    </v-list>

    <!-- Budget readout -->
    <div class="text-caption mt-2" :class="budgetColor ? `text-${budgetColor}` : 'text-medium-emphasis'">
      {{ budgetText }}
    </div>

    <!-- PDF preview dialog -->
    <v-dialog
      :model-value="pdfPreview !== null"
      max-width="900"
      @update:model-value="pdfPreview = null"
    >
      <v-card variant="outlined" rounded="lg">
        <v-card-title class="d-flex align-center">
          {{ pdfPreview?.filename }}
          <v-spacer />
          <v-btn
            icon="mdi-close"
            variant="text"
            :aria-label="t('attachments.remove')"
            @click="pdfPreview = null"
          />
        </v-card-title>
        <v-card-text class="pa-0">
          <iframe
            v-if="pdfPreview"
            :src="src(pdfPreview.fileId)"
            style="width: 100%; height: 80vh; border: 0; background: #fff"
          />
        </v-card-text>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.attachments-field__input {
  display: none;
}
.attachments-field__zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 16px;
  border: 1px dashed rgba(var(--v-theme-on-surface), 0.3);
  border-radius: 8px;
  cursor: pointer;
  color: rgba(var(--v-theme-on-surface), 0.7);
  transition: border-color 0.15s ease, background-color 0.15s ease;
}
.attachments-field__zone--active {
  border-color: rgb(var(--v-theme-primary));
  background-color: rgba(var(--v-theme-primary), 0.06);
}
.attachments-field__zone--disabled {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}
.attachments-field__name--link {
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
</style>
