<script setup lang="ts">
/**
 * FormActions — the standard form action row. Renders a `cancel` slot on the
 * far left, a spacer, and the default slot (primary/save actions) on the far
 * right. Keeps consistent gap spacing across create/edit forms.
 */
</script>

<template>
  <div class="d-flex align-center" style="gap: 12px">
    <slot name="cancel" />
    <v-spacer />
    <slot />
  </div>
</template>
