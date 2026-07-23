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
import type { LineItemInput } from "@/types/domain";
import { majorToMinor, minorToMajor, minorToDisplay, computeDisplayTotals } from "@/utils/money";

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
}>();

const emit = defineEmits<{ "update:modelValue": [LineItemInput[]] }>();

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
          <th style="width: 130px">Unit price</th>
          <th style="width: 90px">Disc %</th>
          <th style="width: 90px">Tax %</th>
          <th style="width: 120px" class="text-right">Total</th>
          <th style="width: 48px" />
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in rows" :key="i">
          <td>
            <v-text-field
              :model-value="row.description"
              :disabled="disabled"
              density="compact"
              variant="plain"
              hide-details
              aria-label="Line description"
              @update:model-value="(v) => updateRow(i, { description: v })"
            />
          </td>
          <td>
            <v-text-field
              :model-value="row.quantity"
              :disabled="disabled"
              type="number"
              density="compact"
              variant="plain"
              hide-details
              aria-label="Quantity"
              @update:model-value="(v) => updateRow(i, { quantity: v === '' ? null : Number(v) })"
            />
          </td>
          <td>
            <v-text-field
              :model-value="row.unitPriceMajor"
              :disabled="disabled"
              type="number"
              density="compact"
              variant="plain"
              hide-details
              :prefix="currency"
              aria-label="Unit price"
              @update:model-value="(v) => updateRow(i, { unitPriceMajor: v })"
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
        variant="text"
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
  </div>
</template>
