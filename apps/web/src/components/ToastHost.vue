<script setup lang="ts">
/**
 * Global toast host. Mounted once in AppShell; renders the shared `toasts` queue
 * (see useToast) as stacked Vuetify snackbars in the bottom-right. Auto-dismisses
 * each after its timeout; the queue is the single source of truth.
 */
import { toasts, dismissToast, type ToastTone } from "@/composables/useToast";

const colorFor = (tone: ToastTone): string => {
  switch (tone) {
    case "success":
      return "success";
    case "error":
      return "error";
    case "warning":
      return "warning";
    default:
      return "info";
  }
};

const iconFor = (tone: ToastTone): string => {
  switch (tone) {
    case "success":
      return "mdi-check-circle";
    case "error":
      return "mdi-alert-circle";
    case "warning":
      return "mdi-alert";
    default:
      return "mdi-information";
  }
};
</script>

<template>
  <div class="toast-host">
    <v-snackbar
      v-for="item in toasts"
      :key="item.id"
      :model-value="true"
      :color="colorFor(item.tone)"
      :timeout="item.timeout"
      location="bottom right"
      variant="elevated"
      role="alert"
      @update:model-value="dismissToast(item.id)"
    >
      <div class="d-flex align-center" style="gap: 8px">
        <v-icon :icon="iconFor(item.tone)" size="20" />
        <span>{{ item.text }}</span>
      </div>
      <template #actions>
        <v-btn
          icon="mdi-close"
          variant="text"
          size="small"
          @click="dismissToast(item.id)"
        />
      </template>
    </v-snackbar>
  </div>
</template>
