<script setup lang="ts">
/**
 * LineItemEditor — edits the raw line items for a quote/invoice. Emits ONLY the
 * fields the server accepts (description, quantity, unitPriceMinor, discountRate?,
 * taxRate?). Per-line and document totals are shown read-only and computed
 * client-side for immediate feedback; the server recomputes authoritatively and
 * client totals are never sent.
 *
 * Price is edited in MAJOR units (e.g. 10.50) and converted to minor units on
 * emit via majorToMinor.
 */
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { LineItemInput } from "@/types/domain";
import type { PlaceholderDocType } from "@billy/shared/template";
import { majorToMinor, minorToMajor, minorToDisplay, computeDisplayTotals } from "@/utils/money";
import PlaceholderInsertMenu from "@/components/PlaceholderInsertMenu.vue";
import PlaceholderLegend from "@/components/PlaceholderLegend.vue";
import { usePlaceholderInsert } from "@/composables/usePlaceholderInsert";

/**
 * Editor-local row. The price is held as a raw string so intermediate decimal
 * input (e.g. "10." while typing "10.50") is never rewritten mid-keystroke —
 * we only convert to minor units when emitting to the parent. Local `rows`
 * state (not a computed off props) avoids the major→minor→major round-trip that
 * would fight the number input.
 */
interface EditorRow {
  description: string;
  quantity: number | null;
  unitPriceMajor: string;
  discountRate: number | null;
  taxRate: number | null;
}

const props = defineProps<{
  modelValue: LineItemInput[];
  currency: string;
  disabled?: boolean;
  /** Document family — enables the right-click placeholder-insert menu on the
   *  description field (scoped to this doc type). Omit to disable the menu. */
  docType?: PlaceholderDocType;
  /** Server-side field errors keyed `${rowIndex}.${field}` (already translated),
   *  e.g. `{ "0.description": "This field is required" }`. */
  errors?: Record<string, string>;
}>();

const emit = defineEmits<{ "update:modelValue": [LineItemInput[]] }>();

const { t } = useI18n();

// Rules mirror the backend LineItemSchema (@billy/validation): description is
// required, quantity must be > 0 — so the form blocks the submit instead of
// relying on the server round-trip.
const descriptionRule = (v: unknown): boolean | string =>
  (!!v && String(v).trim().length > 0) || t("validations.requiredField");
const quantityRule = (v: unknown): boolean | string =>
  (v !== null && v !== "" && Number(v) > 0) || t("validations.quantityPositive");
const unitPriceRule = (v: unknown): boolean | string =>
  v === "" || v == null || majorToMinor(stripGrouping(String(v))) !== null || t("validations.invalidValue");

const cellError = (index: number, field: string): string | undefined =>
  props.errors?.[`${index}.${field}`];

// Right-click placeholder insert on line-item descriptions (only when docType is set).
const { onContextMenu, menuState, insertToken } = usePlaceholderInsert();

const emptyRow = (): EditorRow => {
  return { description: "", quantity: 1, unitPriceMajor: "", discountRate: null, taxRate: null };
};

const toRow = (li: LineItemInput): EditorRow => {
  const major = minorToMajor(li.unitPriceMinor);
  return {
    description: li.description,
    quantity: li.quantity,
    unitPriceMajor: major === null ? "" : String(major),
    discountRate: li.discountRate ?? null,
    taxRate: li.taxRate ?? null,
  };
};

const rows = ref<EditorRow[]>([]);

const seed = (items: LineItemInput[]): void => {
  rows.value = items.length > 0 ? items.map(toRow) : [emptyRow()];
};
seed(props.modelValue);

// Re-seed only when the parent replaces the array by identity (e.g. loaded an
// existing doc). Our own emits pass new arrays too, so guard with a self flag.
let selfUpdate = false;
watch(
  () => props.modelValue,
  (next) => {
    if (selfUpdate) {
      selfUpdate = false;
      return;
    }
    seed(next);
  },
);

const rowToInput = (r: EditorRow): LineItemInput => {
  const line: LineItemInput = {
    description: r.description,
    quantity: Number(r.quantity) || 0,
    unitPriceMinor: majorToMinor(r.unitPriceMajor) ?? 0,
  };
  if (r.discountRate != null) line.discountRate = Number(r.discountRate);
  if (r.taxRate != null) line.taxRate = Number(r.taxRate);
  return line;
};

const emitRows = (): void => {
  selfUpdate = true;
  emit("update:modelValue", rows.value.map(rowToInput));
};

const updateRow = (index: number, patch: Partial<EditorRow>): void => {
  const row = rows.value[index];
  if (!row) return;
  rows.value[index] = { ...row, ...patch };
  emitRows();
};

// ── Unit-price live formatting ──────────────────────────────────────────────
// The stored `unitPriceMajor` is a CLEAN numeric string ("1234.5"); the input
// DISPLAYS a grouped version ("1,234.5") that updates as you type. We strip the
// grouping on input before storing so majorToMinor (Number()) still parses it.
const groupSep = ","; // thousands separator (display only)
const decSep = "."; // decimal separator the numeric store uses

/** Strip display grouping → a clean numeric string majorToMinor can parse. */
const stripGrouping = (raw: string): string => raw.split(groupSep).join("");

/** Group the integer part with thousands separators, preserving an in-progress
 *  decimal part (e.g. "1234." or "1234.5" stay intact after grouping). Anything
 *  that isn't a number-in-progress is returned stripped, unformatted. */
const formatMajorDisplay = (clean: string): string => {
  if (clean === "" || clean === "-") return clean;
  const neg = clean.startsWith("-");
  const body = neg ? clean.slice(1) : clean;
  const dot = body.indexOf(decSep);
  const intPart = dot === -1 ? body : body.slice(0, dot);
  const fracPart = dot === -1 ? "" : body.slice(dot); // includes the "."
  // Only group a pure-digit integer part; leave odd input untouched.
  if (!/^\d*$/u.test(intPart)) return clean;
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/gu, groupSep);
  return `${neg ? "-" : ""}${grouped}${fracPart}`;
};

/** Handle input on the unit-price field: strip grouping, store the clean value. */
const onUnitPriceInput = (index: number, displayed: string): void => {
  const clean = stripGrouping(displayed);
  updateRow(index, { unitPriceMajor: clean });
};

const addRow = (): void => {
  rows.value = [...rows.value, emptyRow()];
  emitRows();
};

const removeRow = (index: number): void => {
  const next = rows.value.filter((_, i) => i !== index);
  rows.value = next.length > 0 ? next : [emptyRow()];
  emitRows();
};

const rowToTotalsInput = (r: EditorRow): {
  quantity: number;
  unitPriceMinor: number;
  discountRate?: number;
  taxRate?: number;
} => {
  return {
    quantity: Number(r.quantity) || 0,
    unitPriceMinor: majorToMinor(r.unitPriceMajor) ?? 0,
    discountRate: r.discountRate ?? undefined,
    taxRate: r.taxRate ?? undefined,
  };
};

const lineTotalMinor = (r: EditorRow): number => {
  return computeDisplayTotals([rowToTotalsInput(r)]).grandTotalMinor;
};

const totals = computed(() => computeDisplayTotals(rows.value.map(rowToTotalsInput)));
</script>

<template>
  <div>
    <div class="text-subtitle-2 mb-2">Line items</div>
    <v-table density="compact">
      <thead>
        <tr>
          <th style="min-width: 200px">Description</th>
          <th style="width: 90px">Qty</th>
          <th style="width: 160px">Unit price ({{ currency }})</th>
          <th style="width: 90px">Disc %</th>
          <th style="width: 90px">Tax %</th>
          <th style="width: 120px" class="text-right">Total</th>
          <th style="width: 48px" />
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in rows" :key="i">
          <td>
            <v-textarea
              :model-value="row.description"
              :disabled="disabled"
              density="compact"
              variant="plain"
              hide-details="auto"
              rows="1"
              auto-grow
              aria-label="Line description"
              :rules="[descriptionRule]"
              :error-messages="cellError(i, 'description')"
              :class="{ 'placeholder-field': docType }"
              @update:model-value="(v) => updateRow(i, { description: v })"
              @contextmenu="docType ? onContextMenu($event) : undefined"
            >
              <template v-if="docType" #append-inner>
                <PlaceholderLegend :doc-type="docType" />
              </template>
            </v-textarea>
          </td>
          <td>
            <v-text-field
              :model-value="row.quantity"
              :disabled="disabled"
              type="number"
              density="compact"
              variant="plain"
              hide-details="auto"
              aria-label="Quantity"
              :rules="[quantityRule]"
              :error-messages="cellError(i, 'quantity')"
              @update:model-value="(v) => updateRow(i, { quantity: v === '' ? null : Number(v) })"
            />
          </td>
          <td>
            <v-text-field
              :model-value="formatMajorDisplay(row.unitPriceMajor)"
              :disabled="disabled"
              type="text"
              inputmode="decimal"
              density="compact"
              variant="plain"
              hide-details="auto"
              aria-label="Unit price"
              :rules="[unitPriceRule]"
              :error-messages="cellError(i, 'unitPriceMinor')"
              @update:model-value="(v) => onUnitPriceInput(i, v)"
            />
          </td>
          <td>
            <v-text-field
              :model-value="row.discountRate"
              :disabled="disabled"
              type="number"
              density="compact"
              variant="plain"
              hide-details
              aria-label="Discount rate"
              @update:model-value="(v) => updateRow(i, { discountRate: v === '' ? null : Number(v) })"
            />
          </td>
          <td>
            <v-text-field
              :model-value="row.taxRate"
              :disabled="disabled"
              type="number"
              density="compact"
              variant="plain"
              hide-details
              aria-label="Tax rate"
              @update:model-value="(v) => updateRow(i, { taxRate: v === '' ? null : Number(v) })"
            />
          </td>
          <td class="text-right">{{ minorToDisplay(lineTotalMinor(row), currency) }}</td>
          <td>
            <v-btn
              icon="mdi-delete-outline"
              variant="text"
              color="error"
              size="small"
              :disabled="disabled"
              aria-label="Remove line"
              @click="removeRow(i)"
            />
          </td>
        </tr>
      </tbody>
    </v-table>

    <div class="d-flex align-center mt-2">
      <v-btn
        color="primary"
        size="small"
        prepend-icon="mdi-plus"
        :disabled="disabled"
        @click="addRow"
      >
        Add line
      </v-btn>
      <v-spacer />
      <div class="text-right" style="min-width: 220px">
        <div class="d-flex justify-space-between text-body-2">
          <span>Subtotal</span><span>{{ minorToDisplay(totals.subtotalMinor, currency) }}</span>
        </div>
        <div class="d-flex justify-space-between text-body-2">
          <span>Discount</span><span>{{ minorToDisplay(totals.discountMinor, currency) }}</span>
        </div>
        <div class="d-flex justify-space-between text-body-2">
          <span>Tax</span><span>{{ minorToDisplay(totals.taxMinor, currency) }}</span>
        </div>
        <div class="d-flex justify-space-between text-subtitle-1 font-weight-medium">
          <span>Total</span><span>{{ minorToDisplay(totals.grandTotalMinor, currency) }}</span>
        </div>
        <div class="text-caption" style="color: var(--v-billy-text-3)">
          Totals are indicative — the server recalculates on save.
        </div>
      </div>
    </div>
    <PlaceholderInsertMenu v-if="docType" :state="menuState" :doc-type="docType" @insert="insertToken" />
  </div>
</template>
