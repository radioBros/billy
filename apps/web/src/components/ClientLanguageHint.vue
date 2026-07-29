<script setup lang="ts">
/**
 * A small chip that tells the user which LANGUAGE the selected client prefers, so
 * when they write open-text fields (subject, notes) they know which language to
 * use — the document + email render in that language. Shows nothing when the
 * client has no preferred language set (then the company default / English
 * applies, and any language is fine).
 *
 * Uses the client's language NATIVE NAME from the shared LOCALES table, so it
 * needs no per-key translation (a native endonym reads the same in any UI locale).
 */
import { computed } from "vue";
import { LOCALES, normalizeLocale } from "@billy/shared/locales";

const props = defineProps<{ locale?: string | null }>();

const nativeName = computed<string | null>(() => {
  if (!props.locale) return null;
  const code = normalizeLocale(props.locale);
  return LOCALES.find((l) => l.code === code)?.nativeName ?? null;
});
</script>

<template>
  <v-chip
    v-if="nativeName"
    size="small"
    variant="tonal"
    color="deep-purple"
    prepend-icon="mdi-translate"
    class="mb-3"
  >
    {{ nativeName }}
  </v-chip>
</template>
