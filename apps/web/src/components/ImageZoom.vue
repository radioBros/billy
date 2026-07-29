<script setup lang="ts">
/**
 * ImageZoom — a thumbnail preview that opens the full image in a fullscreen
 * overlay on click. Reused for every uploaded-image preview (branding logo,
 * favicon, login background, company document logo, …).
 *
 * Renders a `<v-img>` thumbnail bounded by maxHeight/maxWidth with a zoom cursor
 * and a small hover magnify hint. Clicking (or Enter/Space when focused) opens a
 * dialog showing the image `contain`-fit to the viewport; clicking the backdrop,
 * the ×, or pressing Esc (v-dialog default) closes it. Purely presentational —
 * no upload/network logic here.
 */
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  src: string;
  alt?: string;
  maxHeight?: number | string;
  maxWidth?: number | string;
}>();

const { t } = useI18n();
const open = ref(false);
const failed = ref(false);

const px = (v: number | string | undefined, fallback: number): string =>
  typeof v === "number" ? `${v}px` : (v ?? `${fallback}px`);

const thumbStyle = computed(() => ({
  maxHeight: px(props.maxHeight, 48),
  maxWidth: px(props.maxWidth, 180),
}));
</script>

<template>
  <div class="image-zoom">
    <!-- Plain <img> (NOT v-img): v-img with only max-* constraints collapses to
         zero height and renders blank even when the bytes load fine. object-fit
         keeps aspect ratio within the bounds. Click opens the full-size overlay. -->
    <img
      v-if="!failed"
      :src="src"
      :alt="alt"
      class="image-zoom__thumb"
      :style="thumbStyle"
      :title="t('common.viewFullSize')"
      @click="open = true"
      @error="failed = true"
    />
    <span v-else class="image-zoom__broken" :title="alt">
      <v-icon icon="mdi-image-off-outline" size="20" />
    </span>

    <v-dialog v-model="open" max-width="1200" @update:model-value="open = $event">
      <v-card class="image-zoom__overlay" rounded="lg">
        <div class="d-flex justify-end pa-2">
          <v-btn
            icon="mdi-close"
            variant="text"
            :aria-label="t('common.close')"
            @click="open = false"
          />
        </div>
        <!-- White background so transparent PNGs/SVGs are visible; clicking the
             image closes, matching the backdrop. -->
        <div class="image-zoom__full" @click="open = false">
          <img :src="src" :alt="alt" class="image-zoom__full-img" />
        </div>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.image-zoom {
  display: inline-flex;
}
/* Plain img thumbnail: object-fit keeps aspect ratio inside the max bounds; the
   pointer cursor signals it's clickable (cross-browser). */
.image-zoom__thumb {
  display: block;
  height: auto;
  width: auto;
  object-fit: contain;
  cursor: pointer;
  border-radius: 4px;
}
.image-zoom__broken {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: rgba(var(--v-theme-on-surface), 0.4);
}
/* Explicit white background so transparent logos read clearly regardless of the
   viewer's light/dark theme. */
.image-zoom__overlay {
  background: #ffffff;
}
.image-zoom__full {
  cursor: pointer;
  padding: 16px 24px 32px;
  text-align: center;
}
.image-zoom__full-img {
  max-width: 100%;
  max-height: 80vh;
  object-fit: contain;
}
</style>
