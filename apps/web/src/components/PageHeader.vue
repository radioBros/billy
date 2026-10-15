<script setup lang="ts">
/**
 * PageHeader — the one page title row for every list/form/detail page.
 *
 *   <PageHeader :title="t('invoices.title')" :primary="{ label: t('invoices.new'), icon: 'mdi-plus', to: { name: 'invoice-create' } }">
 *     <template #actions> …extra buttons… </template>
 *   </PageHeader>
 *
 * Desktop (≥600px): title (+ optional back arrow) on the left, `#actions` and the
 * primary button on the right — the exact row the pages used to hand-roll.
 *
 * Phone (<600px): a compact title row (back arrow + title + `#mobile-actions`
 * icons). The `primary` action becomes a floating action button above the bottom
 * navigation, and `#actions` wraps onto its own horizontally-scrollable row so
 * nothing ever overflows the viewport.
 */
import { useRouter, type RouteLocationRaw } from "vue-router";
import { useI18n } from "vue-i18n";
import { useIsMobile } from "@/composables/useIsMobile";

export interface PageHeaderPrimary {
  label: string;
  icon?: string;
  to?: RouteLocationRaw;
  onClick?: () => void;
  color?: string;
}

const props = withDefaults(
  defineProps<{
    title: string;
    subtitle?: string;
    /** Show a back arrow (router.back()). */
    back?: boolean;
    primary?: PageHeaderPrimary | null;
  }>(),
  { subtitle: undefined, back: false, primary: null },
);

const router = useRouter();
const { t } = useI18n();
const isMobile = useIsMobile();

const onPrimary = (): void => {
  props.primary?.onClick?.();
};
</script>

<template>
  <div class="page-header" :class="{ 'page-header--mobile': isMobile }">
    <div class="page-header__row">
      <v-btn
        v-if="back"
        icon="mdi-arrow-left"
        variant="text"
        class="page-header__back"
        :aria-label="t('common.back')"
        @click="router.back()"
      />
      <div class="page-header__titles">
        <h1 class="page-header__title text-h5">
          <slot name="title">{{ title }}</slot>
        </h1>
        <div v-if="subtitle || $slots.subtitle" class="page-header__subtitle">
          <slot name="subtitle">{{ subtitle }}</slot>
        </div>
      </div>
      <v-spacer />
      <template v-if="isMobile">
        <slot name="mobile-actions" />
      </template>
      <template v-else>
        <div v-if="$slots.actions" class="page-header__actions">
          <slot name="actions" />
        </div>
        <v-btn
          v-if="primary"
          :color="primary.color ?? 'primary'"
          :prepend-icon="primary.icon"
          :to="primary.to"
          @click="onPrimary"
        >
          {{ primary.label }}
        </v-btn>
      </template>
    </div>

    <div v-if="isMobile && $slots.actions" class="page-header__actions-scroll">
      <slot name="actions" />
    </div>

    <!-- Phone: the primary action floats above the bottom navigation
         (position: fixed — see .billy-fab in styles/app.scss). -->
    <v-btn
        v-if="isMobile && primary"
        class="billy-fab"
        :color="primary.color ?? 'primary'"
        variant="flat"
        size="large"
        rounded="xl"
        :prepend-icon="primary.icon ?? 'mdi-plus'"
        :to="primary.to"
        :aria-label="primary.label"
        @click="onPrimary"
      >
        {{ primary.label }}
      </v-btn>
  </div>
</template>

<style scoped>
.page-header {
  margin-bottom: 16px;
}
.page-header__row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.page-header__titles {
  min-width: 0;
}
.page-header__title {
  overflow-wrap: anywhere;
}
.page-header__subtitle {
  font-size: 0.875rem;
  color: var(--v-billy-text-3, rgba(var(--v-theme-on-surface), 0.6));
}
.page-header__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

/* ── Phone ───────────────────────────────────────────────────────────── */
.page-header--mobile {
  margin-bottom: 12px;
}
.page-header--mobile .page-header__row {
  gap: 4px;
  min-height: 44px;
}
.page-header--mobile .page-header__back {
  margin-left: -8px;
}
.page-header--mobile .page-header__title {
  font-size: 1.375rem !important;
  line-height: 1.25;
  font-weight: 700;
  letter-spacing: -0.02em !important;
}
.page-header__actions-scroll {
  display: flex;
  gap: 8px;
  margin: 10px -12px 0;
  padding: 0 12px 2px;
  overflow-x: auto;
  scrollbar-width: none;
}
.page-header__actions-scroll::-webkit-scrollbar {
  display: none;
}
.page-header__actions-scroll > :deep(*) {
  flex: 0 0 auto;
}
</style>
