<script setup lang="ts">
/**
 * LocalizedTextEditor — a per-language editor for company free-text settings
 * fields (WYSIWYG header/footer, per-doc footers/notes). It v-models a
 * `{ [locale]: string }` map so an admin can author each field in any of the
 * supported languages; a small language `<v-select>` sits next to the section
 * label and swaps which map entry the inner editor edits.
 *
 * The inner editor is either the shared print-safe WYSIWYG (`RichTextEditor`,
 * mode "rich") or a plain `<v-textarea>` (mode "textarea") — both v-model a
 * plain `string`, so this component funnels the currently-selected language's
 * entry through a computed proxy that REASSIGNS the whole map on write (never
 * mutating in place), guaranteeing the parent's `update:modelValue` fires and a
 * save never ships stale data.
 *
 * Storage is backward-compatible: parents load via `toLocalizedMap()` (a legacy
 * plain string seeds under the default locale) and save the map as-is (or null
 * when empty). This component only ever deals in the map form.
 */
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { LOCALES, DEFAULT_LOCALE } from "@billy/shared/locales";
import RichTextEditor from "@/components/RichTextEditor.vue";

const { t } = useI18n();

const model = defineModel<Record<string, string>>({ default: () => ({}) });

withDefaults(
  defineProps<{
    label: string;
    mode?: "rich" | "textarea";
  }>(),
  { mode: "rich" },
);

const localeItems = LOCALES.map((l) => ({ title: l.nativeName, value: l.code }));

const hasContent = (v: string | undefined): boolean => v != null && v.trim().length > 0;

/** Default selection: the app default locale, else the first language with content. */
const initialLocale = (): string => {
  if (hasContent(model.value[DEFAULT_LOCALE])) return DEFAULT_LOCALE;
  const firstWithContent = LOCALES.find((l) => hasContent(model.value[l.code]));
  return firstWithContent?.code ?? DEFAULT_LOCALE;
};

const selectedLocale = ref<string>(initialLocale());

// The parent loads its map asynchronously (after this component mounts). Re-pick
// the default selection ONCE, when content first arrives, so a field authored
// only in a non-default language opens to that language (not an empty default).
const pickedInitial = ref(false);
watch(
  model,
  (map) => {
    if (pickedInitial.value) return;
    if (Object.values(map).some(hasContent)) {
      selectedLocale.value = initialLocale();
      pickedInitial.value = true;
    }
  },
  { immediate: true, deep: true },
);

/**
 * The inner editor's `string` v-model for the CURRENTLY-selected language.
 * Writing reassigns the whole map (spread) so the parent v-model updates — an
 * in-place mutation would not reliably trigger `update:modelValue`.
 */
const current = computed<string>({
  get: () => model.value[selectedLocale.value] ?? "",
  set: (v: string) => {
    model.value = { ...model.value, [selectedLocale.value]: v };
  },
});

/** Upper-cased codes of languages that already have (non-blank) content. */
const filledLocales = computed<string[]>(() =>
  LOCALES.filter((l) => hasContent(model.value[l.code])).map((l) => l.code.toUpperCase()),
);
</script>

<template>
  <div class="localized-text-editor">
    <div class="d-flex align-center justify-space-between mb-1" style="gap: 12px">
      <label class="text-caption text-medium-emphasis">{{ label }}</label>
      <v-select
        v-model="selectedLocale"
        :items="localeItems"
        :label="t('settings.localizedField.language')"
        density="compact"
        variant="outlined"
        hide-details
        class="localized-text-editor__lang"
      />
    </div>

    <RichTextEditor v-if="mode === 'rich'" v-model="current" />
    <v-textarea v-else v-model="current" rows="2" auto-grow density="comfortable" hide-details />

    <div v-if="filledLocales.length" class="text-caption text-medium-emphasis mt-1">
      {{ t("settings.localizedField.languagesWithContent", { locales: filledLocales.join(", ") }) }}
    </div>
  </div>
</template>

<style scoped>
.localized-text-editor__lang {
  max-width: 180px;
  flex: 0 0 auto;
}
</style>
