/**
 * usePlaceholderInsert — right-click placeholder insertion for PLAIN Vuetify text
 * inputs (`v-textarea` / `v-text-field`, which render a native `<textarea>`/`<input>`).
 *
 * Usage (pair with the <PlaceholderInsertMenu> component):
 *
 *   const { onContextMenu, menuState, insertToken } = usePlaceholderInsert("invoice");
 *   <v-textarea v-model="notes" @contextmenu="onContextMenu" />
 *   <PlaceholderInsertMenu :state="menuState" :doc-type="docType" @insert="insertToken" />
 *
 * Why a composable (not a wrapper component): the two consuming shapes diverge — the
 * notes field is a bare `v-textarea` with `v-model`, while LineItemEditor's description
 * is a `v-text-field` bound with `:model-value` + `@update:model-value="(v)=>…"` inside
 * the editor's own row plumbing. A single wrapper cannot serve the in-row case without
 * editing the editor's internals and forwarding its row callbacks (lossy). A composable
 * attaches to whatever native control the field renders and mutates it in place, so
 * Vuetify's own `update:modelValue` fires unchanged — no forwarding needed.
 *
 * Caret-correctness: the selection is captured at CONTEXTMENU time (before the user
 * clicks a menu item and focus leaves the field) and the insert uses those STORED
 * offsets — never live selection, which would be gone by insert time.
 */
import { reactive } from "vue";

/**
 * Literal `{{date …}}` examples injected into i18n date descriptions as t() PARAMS.
 * They live here (not in the message strings) because vue-i18n's compiler treats `{`
 * as interpolation and rejects `{{` as an illegal nested placeholder — so the messages
 * use named slots ({d}/{df}/{dm1}/{dm2}) and we pass these values, which vue-i18n
 * inserts verbatim. One source of truth for both the legend and the insert menu.
 */
export const DATE_EXAMPLE_PARAMS = {
  d: "{{date}}",
  df: '{{date|"dd MMM YYYY"}}',
  dm1: '{{date -1|"MMMM"}}',
  dm2: '{{date -2|"MM/YYYY"}}',
  /** Client-name example token, for prose that illustrates non-date placeholders. */
  cn: "{{client.name}}",
} as const;

/** Reactive menu position/visibility, shared with <PlaceholderInsertMenu>. */
export interface PlaceholderMenuState {
  open: boolean;
  /** Viewport coordinates of the right-click, for `<v-menu :target>`. */
  x: number;
  y: number;
}

/** Locate the native <input>/<textarea> for the field the event fired on. */
const nativeInputFor = (e: MouseEvent): HTMLInputElement | HTMLTextAreaElement | null => {
  const target = e.target as HTMLElement | null;
  // A click on the inner control: climb to it directly.
  const fromTarget = target?.closest("textarea, input") as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  if (fromTarget) return fromTarget;
  // A click on padding/label: @contextmenu binds to the field's root div, so look
  // inside currentTarget for the first native control.
  const current = e.currentTarget as HTMLElement | null;
  const inner = current?.querySelector("textarea, input") as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  return inner ?? null;
};

export const usePlaceholderInsert = () => {
  const menuState = reactive<PlaceholderMenuState>({ open: false, x: 0, y: 0 });

  // The control + selection captured at contextmenu time. `null` selection (e.g.
  // number/email inputs) means we cannot place a caret -> we don't open the menu.
  let el: HTMLInputElement | HTMLTextAreaElement | null = null;
  let start = 0;
  let end = 0;

  const onContextMenu = (e: MouseEvent): void => {
    const input = nativeInputFor(e);
    if (!input || input.selectionStart == null || input.selectionEnd == null) {
      // Not a placeholder-capable control (or caret not queryable) — let the
      // browser's default menu appear and do nothing.
      return;
    }
    e.preventDefault();
    el = input;
    start = input.selectionStart;
    end = input.selectionEnd;
    menuState.x = e.clientX;
    menuState.y = e.clientY;
    menuState.open = true;
  };

  /**
   * Insert `text` at the offsets captured at contextmenu time, replacing any
   * selection, then sync Vuetify's v-model via a real bubbling `input` event and
   * restore focus with the caret after the insert.
   */
  const insertToken = (text: string): void => {
    menuState.open = false;
    const input = el;
    if (!input) return;

    if (typeof input.setRangeText === "function") {
      input.setRangeText(text, start, end, "end");
    } else {
      // Feature-detect fallback (jsdom historically lacked setRangeText): manual
      // splice + caret placement, so the composable stays testable everywhere.
      const value = input.value;
      input.value = value.slice(0, start) + text + value.slice(end);
      const caret = start + text.length;
      input.setSelectionRange(caret, caret);
    }

    // Vuetify reads `target.value` on `input` and emits update:modelValue.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();

    // Next contextmenu re-captures fresh offsets; clear the stale control.
    el = null;
  };

  return { onContextMenu, menuState, insertToken };
};
