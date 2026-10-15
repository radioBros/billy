/**
 * createReusableTemplate — define a chunk of template once and render it in
 * several places of the SAME component (a minimal take on VueUse's helper).
 *
 *   const { Define: DefineFields, Reuse: ReuseFields } = createReusableTemplate();
 *
 *   <DefineFields> …v-cols… </DefineFields>          (renders nothing itself)
 *   <FormSteps v-if="isMobile"> …<ReuseFields />… </FormSteps>
 *   <AppCard v-else> <v-row><ReuseFields /></v-row> </AppCard>
 *
 * Used by the create/edit forms so the phone wizard (fields regrouped into
 * per-step cards) and the untouched desktop card layout share ONE copy of every
 * field — rules, error messages and data-test attributes can't drift apart.
 * Put the `Define` before any `Reuse`; reused content keeps the host component's
 * scope (refs, scoped CSS) and injects from where `Reuse` sits (e.g. the v-form).
 */
import { defineComponent, shallowRef, type Slot } from "vue";

export const createReusableTemplate = () => {
  const render = shallowRef<Slot | undefined>();
  const Define = defineComponent({
    setup(_, { slots }) {
      return () => {
        render.value = slots.default;
        return null;
      };
    },
  });
  const Reuse = defineComponent({
    setup() {
      return () => render.value?.();
    },
  });
  return { Define, Reuse };
};
