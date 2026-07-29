<script setup lang="ts">
/**
 * SettingsSection — a labelled settings group: an optional heading + hint, then
 * the slotted fields, with a divider between sections. Extracted so every
 * settings tab segments its fields the same way (flat theme, no shadow). Local
 * to the settings area; not a global component.
 */
withDefaults(
  defineProps<{
    title?: string;
    hint?: string;
    /** Suppress the leading divider (use on the first section). */
    first?: boolean;
  }>(),
  { title: "", hint: "", first: false },
);
</script>

<template>
  <div>
    <v-divider v-if="!first" class="mb-4" />
    <div v-if="title || hint" class="mb-3">
      <div v-if="title" class="text-subtitle-2 font-weight-medium">{{ title }}</div>
      <div v-if="hint" class="text-caption text-medium-emphasis">{{ hint }}</div>
    </div>
    <slot />
  </div>
</template>
