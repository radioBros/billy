<script setup lang="ts">
/**
 * PlaceholderLegend — a consult-able reference of every placeholder usable in the
 * current document. A small "Placeholders" button opens a menu panel listing
 * `placeholdersForDocType(docType)` grouped by `group` (date → document → client →
 * company), each row showing the literal token (monospaced), its localized
 * description, and a copy-to-clipboard button.
 *
 * The panel also documents the flexible `{{date}}` forms (custom format + signed
 * MONTH OFFSET) and a compact format-token key. Purely presentational — descriptions
 * come from i18n so the catalog (@billy/shared) stays locale-agnostic.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  placeholdersForDocType,
  type PlaceholderDocType,
  type PlaceholderGroup,
  type PlaceholderInfo,
} from "@billy/shared/template";
import { DATE_EXAMPLE_PARAMS } from "@/composables/usePlaceholderInsert";

const props = defineProps<{
  docType: PlaceholderDocType;
}>();

const { t } = useI18n();

const open = ref(false);
const copied = ref<string | null>(null);

// ── Direct-insert support ────────────────────────────────────────────────────
// The legend lives in a field's append-inner, so "insert into the focused field"
// = insert into THIS legend's own field. We capture that native input + its caret
// on `mousedown` of the activator icon (fires BEFORE focus leaves the field for the
// menu), then insert there. Same setRangeText + `input`-event sync as the
// right-click composable so Vuetify's v-model updates.
const root = ref<HTMLElement | null>(null);
let target: HTMLInputElement | HTMLTextAreaElement | null = null;
let caretStart = 0;
let caretEnd = 0;

/** Capture the sibling input + caret before the menu steals focus. */
const captureTarget = (): void => {
  const field = root.value?.closest(".v-input");
  const input = field?.querySelector("textarea, input") as HTMLInputElement | HTMLTextAreaElement | null;
  if (!input) { target = null; return; }
  target = input;
  caretStart = input.selectionStart ?? input.value.length;
  caretEnd = input.selectionEnd ?? input.value.length;
};

/** True when we have a usable target field to insert into (drives the insert icon). */
const canInsert = computed<boolean>(() => target != null);

/** Insert a token at the captured caret of the legend's own field. */
const insertHere = (text: string): void => {
  const input = target;
  if (!input) return;
  if (typeof input.setRangeText === "function") {
    input.setRangeText(text, caretStart, caretEnd, "end");
  } else {
    const v = input.value;
    input.value = v.slice(0, caretStart) + text + v.slice(caretEnd);
    const c = caretStart + text.length;
    input.setSelectionRange(c, c);
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  // Advance the captured caret so successive inserts append in order.
  caretStart += text.length;
  caretEnd = caretStart;
  open.value = false;
  input.focus();
};

// Exposed so tests can drive the panel open without depending on Vuetify's
// activator-click timing under jsdom (production still opens via the button).
defineExpose({ open });

/** Legend grouping order — shared with PlaceholderInsertMenu. */
const GROUP_ORDER: readonly PlaceholderGroup[] = ["date", "document", "client", "company"];

const grouped = computed<{ group: PlaceholderGroup; items: PlaceholderInfo[] }[]>(() => {
  const all = placeholdersForDocType(props.docType);
  return GROUP_ORDER.map((group) => ({
    group,
    items: all.filter((p) => p.group === group),
  })).filter((g) => g.items.length > 0);
});

const copy = async (text: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = text;
    window.setTimeout(() => {
      if (copied.value === text) copied.value = null;
    }, 1500);
  } catch {
    // Clipboard unavailable (insecure context / denied) — silently no-op; the token
    // is still visible for manual selection.
  }
};
</script>

<template>
  <div ref="root" class="placeholder-legend" :class="{ 'placeholder-legend--open': open }">
    <v-menu
      v-model="open"
      :close-on-content-click="false"
      location="bottom start"
      max-width="440"
    >
      <template #activator="{ props: menuProps }">
        <v-icon
          v-bind="menuProps"
          icon="mdi-help-circle-outline"
          color="primary"
          size="small"
          class="placeholder-legend__icon"
          role="button"
          tabindex="0"
          :aria-label="t('placeholders.legendButton')"
          :title="t('placeholders.legendButton')"
          @mousedown="captureTarget"
        />
      </template>
      <v-card class="placeholder-legend__panel" rounded="lg" elevation="6">
        <v-card-text>
            <!-- How-to note + dates explainer + format key. -->
            <p class="text-body-2 mb-2">{{ t("placeholders.help") }}</p>
            <v-alert
              type="info"
              variant="tonal"
              density="compact"
              class="mb-3 text-body-2"
            >
              <div>{{ t("placeholders.dateHelp", DATE_EXAMPLE_PARAMS) }}</div>
              <div class="mt-2 text-caption text-medium-emphasis">
                {{ t("placeholders.formatKey") }}
              </div>
            </v-alert>

            <div v-for="(g, gi) in grouped" :key="g.group">
              <v-divider v-if="gi > 0" class="my-2" />
              <div class="text-overline text-medium-emphasis mb-1">
                {{ t("placeholders.groups." + g.group) }}
              </div>
              <div
                v-for="p in g.items"
                :key="p.token"
                class="placeholder-legend__row d-flex align-center py-1"
              >
                <code class="placeholder-legend__token">{{ p.insert }}</code>
                <span class="placeholder-legend__desc text-body-2 text-medium-emphasis">
                  {{ t("placeholders.tokens." + p.descKey, DATE_EXAMPLE_PARAMS) }}
                </span>
                <!-- Insert directly into the field the legend belongs to (shown only
                     when a target field/caret was captured on open). -->
                <v-btn
                  v-if="canInsert"
                  icon="mdi-cursor-text"
                  color="primary"
                  variant="text"
                  size="x-small"
                  density="comfortable"
                  :aria-label="t('placeholders.insertHere')"
                  :title="t('placeholders.insertHere')"
                  @click="insertHere(p.insert)"
                />
                <v-btn
                  :icon="copied === p.insert ? 'mdi-check' : 'mdi-content-copy'"
                  :color="copied === p.insert ? 'success' : undefined"
                  variant="text"
                  size="x-small"
                  density="comfortable"
                  :aria-label="copied === p.insert ? t('placeholders.copied') : t('placeholders.copy')"
                  @click="copy(p.insert)"
                />
              </div>
            </div>
        </v-card-text>
      </v-card>
    </v-menu>
  </div>
</template>

<style scoped>
.placeholder-legend {
  display: inline-flex;
}
.placeholder-legend__panel {
  max-height: 70vh;
  overflow-y: auto;
}
.placeholder-legend__row {
  gap: 8px;
}
.placeholder-legend__token {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8125rem;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(var(--v-theme-on-surface), 0.06);
  white-space: nowrap;
}
.placeholder-legend__desc {
  flex: 1 1 auto;
}
</style>
