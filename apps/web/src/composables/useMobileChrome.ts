/**
 * useMobileChrome — lets a page temporarily hide the phone bottom navigation
 * (e.g. a stepped create/edit form owns the bottom of the screen with its own
 * Back/Next bar). Reference-counted so nested/overlapping users are safe.
 */
import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue";

const hideRequests = ref(0);

/** True while at least one mounted component asked to hide the bottom nav. */
export const bottomNavHidden = computed(() => hideRequests.value > 0);

/** Hide the bottom nav while `active` is true (and the caller is mounted). */
export const useHideBottomNav = (active: Ref<boolean>): void => {
  let holding = false;
  const set = (on: boolean): void => {
    if (on === holding) return;
    holding = on;
    hideRequests.value += on ? 1 : -1;
  };
  watch(active, (on) => set(on), { immediate: true });
  onBeforeUnmount(() => set(false));
};
