/**
 * useIsMobile — the ONE breakpoint source of truth for the mobile UI.
 *
 * "Mobile" means Vuetify's `xs` breakpoint (viewport < 600px). Components branch
 * on this with `v-if` and render a dedicated phone layout (card lists, stepped
 * forms, bottom navigation…); the ≥600px markup stays untouched.
 *
 * Deliberately NOT Vuetify's `mobile` flag: that one follows `mobileBreakpoint`
 * (default `lg`, i.e. < 1280px) and would switch tablets/small laptops too.
 */
import { computed, type ComputedRef } from "vue";
import { useDisplay } from "vuetify";

export const useIsMobile = (): ComputedRef<boolean> => {
  const { xs } = useDisplay();
  return computed(() => xs.value);
};
