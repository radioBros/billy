<script setup lang="ts">
/**
 * FormActions — the standard form action row. Renders a `cancel` slot on the
 * far left, a spacer, and the default slot (primary/save actions) on the far
 * right. Keeps consistent gap spacing across create/edit forms.
 *
 * Phone (<600px): the cancel slot is dropped (the page header's back arrow and
 * the stepped form's Back button cover it) and the actions share the row
 * equally so they never overflow.
 */
import { useIsMobile } from "@/composables/useIsMobile";

const isMobile = useIsMobile();
</script>

<template>
  <div v-if="isMobile" class="form-actions--mobile">
    <slot />
  </div>
  <div v-else class="d-flex align-center" style="gap: 12px">
    <slot name="cancel" />
    <v-spacer />
    <slot />
  </div>
</template>

<style scoped>
.form-actions--mobile {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.form-actions--mobile > :deep(.v-btn) {
  flex: 1 1 0;
  min-width: 0;
  height: 48px;
  padding: 0 12px !important;
}
.form-actions--mobile > :deep(.v-btn .v-btn__content) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
}
/* The primary (submit) button gets the larger share. */
.form-actions--mobile > :deep(.v-btn[type="submit"]) {
  flex-grow: 1.6;
}
</style>
