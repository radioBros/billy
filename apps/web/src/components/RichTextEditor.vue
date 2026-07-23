<script setup lang="ts">
/**
 * RichTextEditor — a reusable print-safe WYSIWYG (TipTap v3) bound to an HTML
 * string via `defineModel`. It replaces the ad-hoc `v-textarea` for the
 * document header/footer HTML (the DRY sibling of ColorInput): one component,
 * one aesthetic — a flat, light-grey-bordered container matching the settings
 * theme (no shadow).
 *
 * Formatting is print-safe: it excludes file uploads and "messy" embeds
 * (images, tables, iframes, colors that fight the brand palette). What it DOES
 * offer is everything a person writing a document header/footer actually wants:
 *   - paragraph vs. headings (H1–H3)
 *   - font size (via TextStyle's fontSize attribute, inline style)
 *   - bold / italic / underline / strike / inline code
 *   - bullet + ordered lists, blockquote, horizontal rule
 *   - text-align left/center/right
 *   - links
 *   - undo / redo + clear-formatting
 *   - an HTML SOURCE toggle so power users can paste/edit raw HTML directly
 *
 * The emitted HTML flows into the server's Playwright PDF path (and a sanitized
 * preview). All the marks/nodes above serialize to plain semantic HTML the PDF
 * renderer reproduces; the sanitizer only strips scripts/handlers, so nothing
 * here silently vanishes.
 *
 * StarterKit v3 bundles Link (and heading, blockquote, code, hr, strike,
 * underline, history); we disable its Link and register our own configured Link
 * (openOnClick off) to avoid a duplicate-extension schema clash.
 */
import { ref, watch, computed, onBeforeUnmount } from "vue";
import { useEditor, EditorContent } from "@tiptap/vue-3";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle, FontSize } from "@tiptap/extension-text-style";
import Image from "@tiptap/extension-image";

const model = defineModel<string>({ default: "" });

withDefaults(
  defineProps<{
    label?: string;
    disabled?: boolean;
  }>(),
  { label: "", disabled: false },
);

/** "<p></p>" is TipTap's empty doc — normalize it to "" so an untouched field is empty. */
const EMPTY_DOC = "<p></p>";
const normalize = (html: string): string => (html === EMPTY_DOC ? "" : html);

const editor = useEditor({
  content: model.value ?? "",
  extensions: [
    StarterKit.configure({ link: false }),
    Link.configure({ openOnClick: false, autolink: true }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    // TextStyle carries the fontSize attribute (inline `style="font-size:…"`).
    TextStyle,
    FontSize,
    // Inline images embedded as base64 data-URIs (allowBase64) so a logo in a
    // header/footer is self-contained — no external fetch to fail in the email or
    // the Playwright PDF path. `width` is kept in the schema for sizing.
    Image.extend({
      addAttributes() {
        return {
          ...this.parent?.(),
          width: {
            default: null,
            renderHTML: (attrs: { width?: string | number | null }) =>
              attrs.width ? { style: `width: ${attrs.width}px; height: auto;` } : {},
            parseHTML: (el: HTMLElement) => el.getAttribute("width") || el.style.width.replace("px", "") || null,
          },
        };
      },
    }).configure({ inline: false, allowBase64: true }),
  ],
  editable: true,
  onUpdate: ({ editor: e }) => {
    if (showSource.value) return; // source mode owns the model while open
    model.value = normalize(e.getHTML());
  },
});

// Keep the editor in sync when the model is replaced externally (e.g. after the
// tab loads settings). Guard against feeding back our own onUpdate emissions.
watch(model, (value) => {
  const e = editor.value;
  if (!e || showSource.value) return;
  const current = e.getHTML();
  const next = value ?? "";
  if (next !== current && !(next === "" && current === EMPTY_DOC)) {
    e.commands.setContent(next, { emitUpdate: false });
  }
});

// ── HTML source view ────────────────────────────────────────────────────────
// A toggle that swaps the WYSIWYG surface for a raw-HTML textarea. Edits there
// write straight to the model; on toggling back, the editor re-parses the HTML.
const showSource = ref(false);
const sourceDraft = ref("");

const toggleSource = (): void => {
  const e = editor.value;
  if (!e) return;
  if (!showSource.value) {
    // entering source mode: seed the textarea from the current HTML
    sourceDraft.value = normalize(e.getHTML());
    showSource.value = true;
  } else {
    // leaving source mode: push the edited HTML back into the editor
    const html = sourceDraft.value.trim();
    model.value = normalize(html);
    e.commands.setContent(html === "" ? "" : html, { emitUpdate: false });
    showSource.value = false;
  }
};

const onSourceInput = (): void => {
  if (showSource.value) model.value = normalize(sourceDraft.value.trim());
};

// ── Font size ─────────────────────────────────────────────────────────────
const FONT_SIZES = ["10px", "12px", "14px", "16px", "18px", "24px", "32px"] as const;
const currentFontSize = computed<string | null>(() => {
  const e = editor.value;
  if (!e) return null;
  return (e.getAttributes("textStyle").fontSize as string | undefined) ?? null;
});
const setFontSize = (size: string | null): void => {
  const e = editor.value;
  if (!e) return;
  if (size) e.chain().focus().setFontSize(size).run();
  else e.chain().focus().unsetFontSize().run();
};
const onFontSizeChange = (ev: Event): void => {
  setFontSize((ev.target as HTMLSelectElement).value || null);
};

// ── Block type (paragraph / headings) ───────────────────────────────────────
const BLOCK_TYPES = [
  { value: "paragraph", labelKey: "Paragraph" },
  { value: "h1", labelKey: "Heading 1" },
  { value: "h2", labelKey: "Heading 2" },
  { value: "h3", labelKey: "Heading 3" },
] as const;
const currentBlock = computed<string>(() => {
  const e = editor.value;
  if (!e) return "paragraph";
  for (const level of [1, 2, 3] as const) {
    if (e.isActive("heading", { level })) return `h${level}`;
  }
  return "paragraph";
});
const setBlock = (value: string): void => {
  const e = editor.value;
  if (!e) return;
  if (value === "paragraph") e.chain().focus().setParagraph().run();
  else {
    const level = Number(value.slice(1)) as 1 | 2 | 3;
    e.chain().focus().toggleHeading({ level }).run();
  }
};
const onBlockChange = (ev: Event): void => {
  setBlock((ev.target as HTMLSelectElement).value);
};

const setLink = (): void => {
  const e = editor.value;
  if (!e) return;
  const previous = (e.getAttributes("link").href as string | undefined) ?? "";
  const url = window.prompt("URL", previous);
  if (url === null) return; // cancelled
  if (url === "") {
    e.chain().focus().extendMarkRange("link").unsetLink().run();
    return;
  }
  e.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
};

const clearFormatting = (): void => {
  editor.value?.chain().focus().unsetAllMarks().clearNodes().run();
};

// ── Embedded images (base64) + sizing ────────────────────────────────────────
const imageInput = ref<HTMLInputElement | null>(null);
/** Open the file picker to insert an image (embedded as base64). */
const pickImage = (): void => {
  imageInput.value?.click();
};
const onImagePicked = (ev: Event): void => {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // allow re-picking the same file
  if (!file || !editor.value) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result);
    // Embed as a self-contained data-URI so it renders in email + the PDF path.
    editor.value?.chain().focus().setImage({ src: dataUrl }).run();
  };
  reader.readAsDataURL(file);
};
/** True when an image node is currently selected (shows the width control). */
const imageSelected = computed<boolean>(() => editor.value?.isActive("image") ?? false);
const imageWidth = computed<string>(() => {
  const w = editor.value?.getAttributes("image").width;
  return w != null ? String(w) : "";
});
const setImageWidth = (px: string): void => {
  const e = editor.value;
  if (!e || !e.isActive("image")) return;
  const n = Number(px);
  e.chain().focus().updateAttributes("image", { width: Number.isFinite(n) && n > 0 ? n : null }).run();
};
const onImageWidthInput = (ev: Event): void => setImageWidth((ev.target as HTMLInputElement).value);

// Inline-mark toolbar buttons (icon toggles). Kept as a computed so `active`
// reflects the live selection.
const markButtons = computed(() => {
  const e = editor.value;
  if (!e) return [];
  return [
    { key: "bold", icon: "mdi-format-bold", active: e.isActive("bold"), run: () => e.chain().focus().toggleBold().run() },
    { key: "italic", icon: "mdi-format-italic", active: e.isActive("italic"), run: () => e.chain().focus().toggleItalic().run() },
    { key: "underline", icon: "mdi-format-underline", active: e.isActive("underline"), run: () => e.chain().focus().toggleUnderline().run() },
    { key: "strike", icon: "mdi-format-strikethrough-variant", active: e.isActive("strike"), run: () => e.chain().focus().toggleStrike().run() },
    { key: "code", icon: "mdi-code-tags", active: e.isActive("code"), run: () => e.chain().focus().toggleCode().run() },
  ];
});
const blockButtons = computed(() => {
  const e = editor.value;
  if (!e) return [];
  return [
    { key: "bulletList", icon: "mdi-format-list-bulleted", active: e.isActive("bulletList"), run: () => e.chain().focus().toggleBulletList().run() },
    { key: "orderedList", icon: "mdi-format-list-numbered", active: e.isActive("orderedList"), run: () => e.chain().focus().toggleOrderedList().run() },
    { key: "blockquote", icon: "mdi-format-quote-close", active: e.isActive("blockquote"), run: () => e.chain().focus().toggleBlockquote().run() },
    { key: "horizontalRule", icon: "mdi-minus", active: false, run: () => e.chain().focus().setHorizontalRule().run() },
  ];
});
const alignButtons = computed(() => {
  const e = editor.value;
  if (!e) return [];
  return [
    { key: "alignLeft", icon: "mdi-format-align-left", active: e.isActive({ textAlign: "left" }), run: () => e.chain().focus().setTextAlign("left").run() },
    { key: "alignCenter", icon: "mdi-format-align-center", active: e.isActive({ textAlign: "center" }), run: () => e.chain().focus().setTextAlign("center").run() },
    { key: "alignRight", icon: "mdi-format-align-right", active: e.isActive({ textAlign: "right" }), run: () => e.chain().focus().setTextAlign("right").run() },
  ];
});

onBeforeUnmount(() => {
  editor.value?.destroy();
});
</script>

<template>
  <div class="rte">
    <label v-if="label" class="rte__label text-caption text-medium-emphasis">{{ label }}</label>
    <div class="rte__frame" :class="{ 'rte__frame--disabled': disabled }">
      <div v-if="editor" class="rte__toolbar" role="toolbar" :aria-label="label || 'Formatting'">
        <!-- Block type (paragraph / headings) -->
        <select
          class="rte__select"
          data-rte-btn="blockType"
          :disabled="disabled || showSource"
          :value="currentBlock"
          aria-label="Block type"
          @change="onBlockChange"
        >
          <option v-for="b in BLOCK_TYPES" :key="b.value" :value="b.value">{{ b.labelKey }}</option>
        </select>

        <!-- Font size -->
        <select
          class="rte__select"
          data-rte-btn="fontSize"
          :disabled="disabled || showSource"
          :value="currentFontSize ?? ''"
          aria-label="Font size"
          @change="onFontSizeChange"
        >
          <option value="">Size</option>
          <option v-for="s in FONT_SIZES" :key="s" :value="s">{{ s.replace('px', '') }}</option>
        </select>

        <span class="rte__sep" />

        <!-- Inline marks -->
        <v-btn
          v-for="btn in markButtons"
          :key="btn.key"
          :data-rte-btn="btn.key"
          :icon="btn.icon"
          :active="btn.active"
          :disabled="disabled || showSource"
          variant="text"
          size="small"
          density="comfortable"
          rounded="0"
          @click="btn.run"
        />

        <span class="rte__sep" />

        <!-- Block formatting -->
        <v-btn
          v-for="btn in blockButtons"
          :key="btn.key"
          :data-rte-btn="btn.key"
          :icon="btn.icon"
          :active="btn.active"
          :disabled="disabled || showSource"
          variant="text"
          size="small"
          density="comfortable"
          rounded="0"
          @click="btn.run"
        />

        <span class="rte__sep" />

        <!-- Alignment -->
        <v-btn
          v-for="btn in alignButtons"
          :key="btn.key"
          :data-rte-btn="btn.key"
          :icon="btn.icon"
          :active="btn.active"
          :disabled="disabled || showSource"
          variant="text"
          size="small"
          density="comfortable"
          rounded="0"
          @click="btn.run"
        />

        <span class="rte__sep" />

        <!-- Link + clear -->
        <v-btn
          data-rte-btn="link"
          icon="mdi-link-variant"
          :active="editor.isActive('link')"
          :disabled="disabled || showSource"
          variant="text"
          size="small"
          density="comfortable"
          rounded="0"
          @click="setLink"
        />
        <v-btn
          data-rte-btn="clear"
          icon="mdi-format-clear"
          :disabled="disabled || showSource"
          variant="text"
          size="small"
          density="comfortable"
          rounded="0"
          @click="clearFormatting"
        />

        <span class="rte__sep" />

        <!-- Insert image (embedded as base64) + width sizing when one is selected -->
        <v-btn
          data-rte-btn="image"
          icon="mdi-image-plus-outline"
          :disabled="disabled || showSource"
          variant="text"
          size="small"
          density="comfortable"
          rounded="0"
          :aria-label="'Insert image'"
          @click="pickImage"
        />
        <span v-if="imageSelected && !showSource" class="rte__imgsize">
          <input
            type="number"
            class="rte__select"
            data-rte-img-width
            min="16"
            step="8"
            style="width: 72px"
            :value="imageWidth"
            placeholder="px"
            aria-label="Image width (px)"
            @input="onImageWidthInput"
          />
          <span class="text-caption ml-1" style="color: rgb(var(--v-theme-on-surface))">px</span>
        </span>

        <span class="rte__sep" />

        <!-- Undo / redo -->
        <v-btn
          data-rte-btn="undo"
          icon="mdi-undo"
          :disabled="disabled || showSource || !editor.can().undo()"
          variant="text"
          size="small"
          density="comfortable"
          rounded="0"
          @click="editor.chain().focus().undo().run()"
        />
        <v-btn
          data-rte-btn="redo"
          icon="mdi-redo"
          :disabled="disabled || showSource || !editor.can().redo()"
          variant="text"
          size="small"
          density="comfortable"
          rounded="0"
          @click="editor.chain().focus().redo().run()"
        />

        <v-spacer />

        <!-- HTML source toggle -->
        <v-btn
          data-rte-btn="source"
          icon="mdi-xml"
          :active="showSource"
          :disabled="disabled"
          variant="text"
          size="small"
          density="comfortable"
          rounded="0"
          aria-label="Edit HTML source"
          @click="toggleSource"
        />
      </div>

      <!-- WYSIWYG surface OR raw-HTML source view -->
      <textarea
        v-if="showSource"
        v-model="sourceDraft"
        class="rte__source"
        data-rte-source
        spellcheck="false"
        :disabled="disabled"
        @input="onSourceInput"
      />
      <editor-content v-else class="rte__content" :editor="editor" />

      <!-- Hidden picker for the insert-image button (embeds the file as base64). -->
      <input
        ref="imageInput"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        style="display: none"
        @change="onImagePicked"
      />
    </div>
  </div>
</template>

<style scoped>
.rte__label {
  display: block;
  margin-bottom: 4px;
}
.rte__frame {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity, 0.24));
  border-radius: 8px;
  overflow: hidden;
  /* Flat theme: no shadow, light-grey border only. */
  background: rgb(var(--v-theme-surface));
}
.rte__frame--disabled {
  opacity: 0.6;
}
.rte__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity, 0.24));
}
.rte__sep {
  width: 1px;
  align-self: stretch;
  margin: 2px 4px;
  background: rgba(var(--v-border-color), var(--v-border-opacity, 0.24));
}
.rte__select {
  height: 30px;
  padding: 0 6px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity, 0.24));
  border-radius: 6px;
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
  font-size: 0.8125rem;
  cursor: pointer;
}
.rte__select:disabled {
  opacity: 0.5;
  cursor: default;
}
.rte__content {
  padding: 8px 12px;
  /* Resizable: drag the bottom-right corner to grow the editor. `resize` needs a
     non-visible overflow to render the grip; `both` gives width + height. */
  resize: both;
  overflow: auto;
  min-height: 120px;
}
.rte__source {
  display: block;
  width: 100%;
  min-height: 140px;
  padding: 8px 12px;
  border: 0;
  outline: none;
  resize: both;
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
  font-family: "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
  font-size: 0.8125rem;
  line-height: 1.5;
}
.rte__content :deep(.ProseMirror) {
  outline: none;
  /* Fill the (resizable) content box so a taller editor gets a taller writable
     area, and clicking anywhere in the grown box focuses the editor. */
  min-height: 100%;
  height: 100%;
  font-size: 0.875rem;
  line-height: 1.5;
}
.rte__content :deep(.ProseMirror p) {
  margin: 0 0 0.5em;
}
.rte__content :deep(.ProseMirror p:last-child) {
  margin-bottom: 0;
}
.rte__content :deep(.ProseMirror h1),
.rte__content :deep(.ProseMirror h2),
.rte__content :deep(.ProseMirror h3) {
  margin: 0 0 0.4em;
  line-height: 1.25;
}
.rte__content :deep(.ProseMirror ul),
.rte__content :deep(.ProseMirror ol) {
  padding-left: 1.25em;
  margin: 0 0 0.5em;
}
.rte__content :deep(.ProseMirror blockquote) {
  border-left: 3px solid rgba(var(--v-border-color), var(--v-border-opacity, 0.4));
  padding-left: 0.75em;
  margin: 0 0 0.5em;
  color: rgb(var(--v-theme-on-surface));
  opacity: 0.85;
}
.rte__content :deep(.ProseMirror hr) {
  border: none;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity, 0.4));
  margin: 0.75em 0;
}
.rte__content :deep(.ProseMirror code) {
  font-family: "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
  font-size: 0.85em;
  background: rgba(var(--v-border-color), 0.12);
  padding: 0.1em 0.3em;
  border-radius: 4px;
}
.rte__content :deep(.ProseMirror a) {
  color: rgb(var(--v-theme-primary));
  text-decoration: underline;
}
/* Embedded images: cap to the editor width by default; a selected image gets a
   primary outline so the width control clearly applies to it. */
.rte__content :deep(.ProseMirror img) {
  max-width: 100%;
  height: auto;
  display: inline-block;
}
.rte__content :deep(.ProseMirror img.ProseMirror-selectednode) {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
.rte__imgsize {
  display: inline-flex;
  align-items: center;
}
</style>
