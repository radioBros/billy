<script setup lang="ts">
/**
 * Consistent card shell for the whole app: a titled HEADER (v-card-title) + body
 * + an actions FOOTER (v-card-actions). Matches the dashboard section-card look
 * (`variant="flat" border`, subtitle-weight title). Use it to wrap form and
 * detail cards so every card reads the same; table-only list cards and dialogs
 * keep their own layout.
 *
 *   <AppCard :title="t('...')">
 *     …fields…
 *     <template #actions> <v-btn>Save</v-btn> </template>
 *   </AppCard>
 */
withDefaults(
  defineProps<{
    /** Header title (omit for a header-less card). */
    title?: string;
    /** Optional caption under the title. */
    subtitle?: string;
  }>(),
  { title: undefined, subtitle: undefined },
);
</script>

<template>
  <v-card variant="flat" border rounded="lg" class="mb-4">
    <v-card-title v-if="title || $slots.header" class="text-subtitle-1 font-weight-medium d-flex align-center">
      <slot name="header">
        <div>
          <div>{{ title }}</div>
          <div v-if="subtitle" class="text-caption text-medium-emphasis">{{ subtitle }}</div>
        </div>
      </slot>
    </v-card-title>
    <v-divider v-if="title || $slots.header" />

    <v-card-text>
      <slot />
    </v-card-text>

    <template v-if="$slots.actions">
      <!-- No <v-divider> here: .v-card-actions already draws a top border (see
           styles/app.scss); a divider too would double it. -->
      <v-card-actions class="px-4 py-3">
        <slot name="actions" />
      </v-card-actions>
    </template>
  </v-card>
</template>
