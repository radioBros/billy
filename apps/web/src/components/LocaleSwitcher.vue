<script setup lang="ts">
/**
 * App-bar locale switcher. Lists supported locales and persists the choice via
 * the locale store (localStorage), mirroring the theme toggle.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useLocaleStore } from "@/stores/locale";
import { SUPPORTED_LOCALES, type SupportedLocale } from "@/plugins/i18n";

const localeStore = useLocaleStore();
const { t } = useI18n();

const current = computed<SupportedLocale>(() => localeStore.current);

const select = (locale: SupportedLocale): void => {
  localeStore.setLocale(locale);
};
</script>

<template>
  <v-menu location="bottom end">
    <template #activator="{ props }">
      <v-btn
        v-bind="props"
        icon
        color="indigo"
        :aria-label="t('locale.label')"
        :title="t('locale.label')"
      >
        <v-icon icon="mdi-translate" />
      </v-btn>
    </template>
    <v-list density="compact" min-width="160">
      <v-list-item
        v-for="loc in SUPPORTED_LOCALES"
        :key="loc"
        :active="loc === current"
        :title="t(`locale.${loc}`)"
        @click="select(loc)"
      >
        <template v-if="loc === current" #append>
          <v-icon icon="mdi-check" size="18" />
        </template>
      </v-list-item>
    </v-list>
  </v-menu>
</template>
