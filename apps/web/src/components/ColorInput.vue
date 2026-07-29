<script setup lang="ts">
/**
 * ColorInput — a single, aligned hex-color field. A colored swatch sits in the
 * text field's `prepend-inner` slot and doubles as the activator for a flat
 * `v-menu` holding a `v-color-picker`. The user can either type a hex or pick
 * one; both paths normalize to a 6-digit lowercase `#rrggbb` (8-digit alpha is
 * stripped via the shared `normalizeHex`). This one component replaces every
 * ad-hoc `v-color-picker` + `v-text-field` pair in settings (the DRY keystone).
 */
import { ref, computed } from "vue";
import { normalizeHex } from "@/stores/branding";

const model = defineModel<string>({ required: true });

withDefaults(
  defineProps<{
    label?: string;
    rules?: ((v: string) => boolean | string)[];
    disabled?: boolean;
  }>(),
  { label: "", rules: () => [], disabled: false },
);

const menu = ref(false);

/** Full-hex pattern (3- or 6-digit, with `#`). Typed 8-digit is handled on normalize. */
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u;

const normalize = (raw: string): string => {
  let v = raw.trim();
  if (v && !v.startsWith("#")) v = `#${v}`;
  if (!HEX_RE.test(v)) return raw;
  v = v.toLowerCase();
  // Expand #rgb → #rrggbb.
  if (/^#[0-9a-f]{3}$/u.test(v)) {
    v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  return normalizeHex(v);
};

/** The swatch shows the current color when valid, else a neutral placeholder. */
const swatchColor = computed(() => (HEX_RE.test(model.value) ? model.value : "transparent"));

const onInput = (raw: string): void => {
  model.value = raw;
};

const onBlur = (): void => {
  model.value = normalize(model.value);
};

const onPick = (v: string): void => {
  model.value = normalize(v);
};
</script>

<template>
  <v-text-field
    :model-value="model"
    :label="label"
    :rules="rules"
    :disabled="disabled"
    density="comfortable"
    spellcheck="false"
    autocapitalize="off"
    autocomplete="off"
    @update:model-value="onInput"
    @blur="onBlur"
  >
    <template #prepend-inner>
      <v-menu v-model="menu" :close-on-content-click="false" location="bottom start">
        <template #activator="{ props: menuProps }">
          <button
            type="button"
            class="color-input__swatch"
            :style="{ backgroundColor: swatchColor }"
            :disabled="disabled"
            :aria-label="label ? `${label}: choose color` : 'Choose color'"
            v-bind="menuProps"
          />
        </template>
        <v-color-picker
          :model-value="model"
          mode="hex"
          flat
          elevation="0"
          hide-inputs
          @update:model-value="onPick"
        />
      </v-menu>
    </template>
  </v-text-field>
</template>

<style scoped>
.color-input__swatch {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  /* Border ensures the swatch is visible against any background (incl. transparent/white),
     honouring the flat theme (no shadow). */
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity, 0.24));
  cursor: pointer;
  flex: 0 0 auto;
  padding: 0;
}
.color-input__swatch:disabled {
  cursor: default;
  opacity: 0.5;
}
</style>
