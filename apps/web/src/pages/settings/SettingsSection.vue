<script setup lang="ts">
/**
 * SettingsSection — a labelled settings group: an optional heading + hint, then
 * the slotted fields, with a divider between sections. Extracted so every
 * settings tab segments its fields the same way (flat theme, no shadow). Local
 * to the settings area; not a global component.
 *
 * Phone (<600px): each section is its own 16px card with an uppercase section
 * label (no dividers) — the tab's outer card goes bare (`.settings-bare`).
 */
import { useIsMobile } from "@/composables/useIsMobile";

withDefaults(
  defineProps<{
    title?: string;
    hint?: string;
    /** Suppress the leading divider (use on the first section). */
    first?: boolean;
  }>(),
  { title: "", hint: "", first: false },
);

const isMobile = useIsMobile();
</script>

<template>
  <div v-if="isMobile" class="settings-section--m">
    <div v-if="title || hint" class="settings-section--m__head">
      <div v-if="title" class="settings-section--m__title">{{ title }}</div>
      <div v-if="hint" class="settings-section--m__hint">{{ hint }}</div>
    </div>
    <slot />
  </div>
  <div v-else>
    <v-divider v-if="!first" class="mb-4" />
    <div v-if="title || hint" class="mb-3">
      <div v-if="title" class="text-subtitle-2 font-weight-medium">{{ title }}</div>
      <div v-if="hint" class="text-caption text-medium-emphasis">{{ hint }}</div>
    </div>
    <slot />
  </div>
</template>

<style scoped>
.settings-section--m {
  background: rgb(var(--v-theme-surface));
  border: 1px solid var(--v-billy-border, #e2e4e9);
  border-radius: 16px;
  padding: 16px;
  margin-bottom: 12px;
  min-width: 0;
}
.settings-section--m__head {
  margin-bottom: 14px;
}
.settings-section--m__title {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.6));
}
.settings-section--m__hint {
  margin-top: 4px;
  font-size: 0.8125rem;
  line-height: 1.4;
  color: var(--v-billy-text-2, rgba(var(--v-theme-on-surface), 0.7));
  overflow-wrap: anywhere;
}
</style>
