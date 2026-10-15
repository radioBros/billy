<script setup lang="ts">
/**
 * FormSteps — turns a long create/edit form into a stepped wizard on phones.
 *
 *   <v-form ref="formRef" @submit.prevent="submit(save)">
 *     <FormSteps :steps="[{ key: 'details', title: t('…'), icon: 'mdi-…' }, …]">
 *       <template #details> …the section's existing card(s)… </template>
 *       <template #items> … </template>
 *       <template #actions> <FormActions>…</FormActions> </template>
 *     </FormSteps>
 *   </v-form>
 *
 * Desktop (≥600px): renders every step slot in order followed by `#actions` —
 * i.e. exactly the markup the page had before. Nothing changes.
 *
 * Phone (<600px): one step at a time, a segmented progress header, and a sticky
 * Back / Next bar (the last step shows `#actions` instead of Next). ALL steps
 * stay mounted (v-show), so the surrounding v-form still validates every field
 * on submit. "Next" validates only the fields inside the current step. When a
 * validation (submit, or server field errors) flags a field on another step,
 * the wizard jumps to the first step holding an error and scrolls it into view.
 */
import { computed, inject, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useIsMobile } from "@/composables/useIsMobile";
import { useHideBottomNav } from "@/composables/useMobileChrome";

export interface FormStep {
  /** Slot name for the step's content (avoid `actions`). */
  key: string;
  title: string;
  icon?: string;
}

const props = defineProps<{ steps: FormStep[] }>();
const current = defineModel<number>("step", { default: 0 });

const { t } = useI18n();
const isMobile = useIsMobile();
useHideBottomNav(isMobile);

// ---- Vuetify form context (the v-form this wizard lives in) ----------------
interface FormField {
  id: string | number;
  vm: { vnode?: { el?: unknown }; subTree?: { el?: unknown } };
  validate: () => Promise<string[]>;
  isValid: boolean | null;
}
const form = inject<{ items: { value: FormField[] } } | null>(Symbol.for("vuetify:form"), null);

const stepEls = ref<(HTMLElement | null)[]>([]);
const setStepEl = (i: number, el: unknown): void => {
  stepEls.value[i] = el instanceof HTMLElement ? el : null;
};

const fieldEl = (f: FormField): Node | null => {
  const el = f.vm?.subTree?.el ?? f.vm?.vnode?.el;
  return el instanceof Node ? el : null;
};

/** Index of the step containing a field (-1 when not inside any step). */
const stepOf = (f: FormField): number => {
  const el = fieldEl(f);
  if (!el) return -1;
  return stepEls.value.findIndex((s) => !!s && s.contains(el));
};

const last = computed(() => props.steps.length - 1);
const safeIndex = computed(() => Math.min(Math.max(current.value, 0), Math.max(last.value, 0)));
const activeStep = computed(() => props.steps[safeIndex.value]);

const scrollToTop = (): void => {
  const top = rootEl.value?.getBoundingClientRect().top ?? 0;
  window.scrollTo({ top: Math.max(0, window.scrollY + top - 72), behavior: "smooth" });
};

const scrollToFirstError = (): void => {
  // After useFormSubmit's own (200ms) attempt, which can't reach hidden steps.
  setTimeout(() => {
    const host = stepEls.value[safeIndex.value];
    const el = host?.querySelector(".v-field--error, .v-input--error");
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, 260);
};

const goTo = (i: number): void => {
  if (i < 0 || i > last.value || i === safeIndex.value) return;
  current.value = i;
  void nextTick(scrollToTop);
};

/** Validate only the fields inside the current step. */
const validateCurrent = async (): Promise<boolean> => {
  const fields = form?.items.value ?? [];
  const mine = fields.filter((f) => stepOf(f) === safeIndex.value);
  const results = await Promise.all(mine.map((f) => f.validate()));
  const ok = results.every((errs) => !errs || errs.length === 0);
  if (!ok) scrollToFirstError();
  return ok;
};

const next = async (): Promise<void> => {
  if (!(await validateCurrent())) return;
  goTo(safeIndex.value + 1);
};

const back = (): void => goTo(safeIndex.value - 1);

/** Tapping a later segment validates the current step first. */
const onSegment = async (i: number): Promise<void> => {
  if (i > safeIndex.value && !(await validateCurrent())) return;
  goTo(i);
};

// ---- jump to errors raised elsewhere (submit / server field errors) ---------
const invalidIds = computed<string[]>(() =>
  (form?.items.value ?? []).filter((f) => f.isValid === false).map((f) => String(f.id)),
);
watch(invalidIds, (now, before) => {
  if (!isMobile.value) return;
  const prev = new Set(before ?? []);
  const fresh = (form?.items.value ?? []).filter((f) => now.includes(String(f.id)) && !prev.has(String(f.id)));
  if (fresh.length === 0) return;
  if (fresh.some((f) => stepOf(f) === safeIndex.value)) return;
  const steps = fresh.map(stepOf).filter((i) => i >= 0);
  if (steps.length === 0) return;
  current.value = Math.min(...steps);
  scrollToFirstError();
});

const rootEl = ref<HTMLElement | null>(null);
</script>

<template>
  <!-- Desktop: the sections exactly as before (no wrappers), then actions. -->
  <template v-if="!isMobile">
    <template v-for="s in steps" :key="s.key">
      <slot :name="s.key" />
    </template>
    <slot name="actions" />
  </template>

  <!-- Phone: one step at a time. -->
  <div v-else ref="rootEl" class="form-steps">
    <div class="form-steps__head">
      <div class="form-steps__segments" role="tablist">
        <button
          v-for="(s, i) in steps"
          :key="s.key"
          type="button"
          role="tab"
          class="form-steps__segment"
          :class="{ 'is-done': i < safeIndex, 'is-active': i === safeIndex }"
          :aria-selected="i === safeIndex"
          :aria-label="s.title"
          @click="onSegment(i)"
        />
      </div>
      <div class="form-steps__label">
        <v-icon v-if="activeStep?.icon" :icon="activeStep.icon" size="18" color="primary" class="mr-2" />
        <span class="form-steps__title">{{ activeStep?.title }}</span>
        <v-spacer />
        <span class="form-steps__counter">{{ t("formSteps.counter", { n: safeIndex + 1, total: steps.length }) }}</span>
      </div>
    </div>

    <div
      v-for="(s, i) in steps"
      v-show="i === safeIndex"
      :key="s.key"
      :ref="(el) => setStepEl(i, el)"
      class="form-steps__body"
    >
      <slot :name="s.key" />
    </div>

    <div class="form-steps__bar">
      <template v-if="safeIndex < last">
        <v-btn
          v-if="safeIndex > 0"
          variant="tonal"
          class="form-steps__back"
          prepend-icon="mdi-chevron-left"
          @click="back"
        >
          {{ t("common.back") }}
        </v-btn>
        <v-btn color="primary" variant="flat" class="form-steps__next" append-icon="mdi-chevron-right" @click="next">
          {{ t("formSteps.next") }}
        </v-btn>
      </template>
      <template v-else>
        <v-btn
          v-if="safeIndex > 0"
          icon="mdi-chevron-left"
          variant="tonal"
          class="form-steps__back form-steps__back--icon px-0"
          :aria-label="t('common.back')"
          @click="back"
        />
        <div class="form-steps__actions">
          <slot name="actions" />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.form-steps__head {
  position: sticky;
  top: var(--v-layout-top, 56px);
  z-index: 3;
  margin: -12px -12px 12px;
  padding: 10px 16px 10px;
  background: rgb(var(--v-theme-background));
  border-bottom: 1px solid var(--v-billy-border, rgba(0, 0, 0, 0.08));
}
.form-steps__segments {
  display: flex;
  gap: 6px;
}
.form-steps__segment {
  flex: 1 1 0;
  height: 6px;
  border-radius: 3px;
  border: 0;
  padding: 0;
  background: rgba(var(--v-theme-on-surface), 0.12);
  cursor: pointer;
  transition: background-color var(--billy-dur, 200ms) ease;
}
.form-steps__segment.is-done {
  background: rgba(var(--v-theme-primary), 0.5);
}
.form-steps__segment.is-active {
  background: rgb(var(--v-theme-primary));
}
.form-steps__label {
  display: flex;
  align-items: center;
  margin-top: 10px;
  min-width: 0;
}
.form-steps__title {
  font-weight: 700;
  font-size: 1rem;
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.form-steps__counter {
  flex: 0 0 auto;
  margin-left: 8px;
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.6));
}
.form-steps__body {
  min-height: 40vh;
}
.form-steps__bar {
  position: sticky;
  bottom: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 16px -12px -24px;
  padding: 12px 12px calc(12px + env(safe-area-inset-bottom, 0px));
  background: rgb(var(--v-theme-surface));
  border-top: 1px solid var(--v-billy-border, rgba(0, 0, 0, 0.08));
}
.form-steps__back {
  flex: 0 0 auto;
}
.form-steps__back--icon {
  width: 48px !important;
  min-width: 48px !important;
  height: 48px !important;
}
.form-steps__next {
  flex: 1 1 auto;
  height: 48px !important;
}
.form-steps__bar :deep(.v-btn) {
  height: 48px;
}
.form-steps__actions {
  flex: 1 1 auto;
  min-width: 0;
}
</style>
