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
import { ref, computed, watch, inject } from "vue";
import { useI18n } from "vue-i18n";
import type { LineItemInput } from "@/types/domain";
import type { PlaceholderDocType } from "@billy/shared/template";
import { majorToMinor, minorToMajor, minorToDisplay, computeDisplayTotals } from "@/utils/money";
import PlaceholderInsertMenu from "@/components/PlaceholderInsertMenu.vue";
import PlaceholderLegend from "@/components/PlaceholderLegend.vue";
import { usePlaceholderInsert } from "@/composables/usePlaceholderInsert";
import { useEInvoicing } from "@/stores/einvoicing";
import { codeItems } from "@/utils/einvoicingCodes";
import { useIsMobile } from "@/composables/useIsMobile";
import { FORM_STEPS_KEY } from "@/components/FormSteps.vue";

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
  /** FatturaPA Natura (why 0% VAT) — kept while taxRate is 0, dropped otherwise. */
  nature: string | null;
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
  /** Offer the Natura (0% VAT reason) column — invoices / credit notes only, and
   *  only while e-invoicing is enabled. */
  showNature?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [LineItemInput[]] }>();

const { t } = useI18n();

// Italian e-invoicing: a 0% VAT line must say WHY (Natura). The extra column and
// select exist only while e-invoicing is enabled.
const einvoicing = useEInvoicing();
void einvoicing.load();
const isMobile = useIsMobile();
// Inside a phone wizard the step header already says "Line items".
const inStepper = inject(FORM_STEPS_KEY, ref(false));
const natureOn = computed<boolean>(() => props.showNature === true && einvoicing.enabled);
const natureItems = computed(() => codeItems(t, "natura"));
const isZeroRate = (r: EditorRow): boolean => r.taxRate !== null && Number(r.taxRate) === 0;

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
  return { description: "", quantity: 1, unitPriceMajor: "", discountRate: null, taxRate: null, nature: null };
};

const toRow = (li: LineItemInput): EditorRow => {
  const major = minorToMajor(li.unitPriceMinor);
  return {
    description: li.description,
    quantity: li.quantity,
    unitPriceMajor: major === null ? "" : String(major),
    discountRate: li.discountRate ?? null,
    taxRate: li.taxRate ?? null,
    nature: li.nature ?? null,
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
  if (r.nature && isZeroRate(r)) line.nature = r.nature;
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
    <div v-if="!inStepper" class="text-subtitle-2 mb-2">Line items</div>

    <!-- Phone: one card per line — description on top, the four figures in a
         2×2 grid, line total + remove in the footer. Same bindings/rules as
         the desktop table below. -->
    <div v-if="isMobile" class="li-cards">
      <div v-for="(row, i) in rows" :key="i" class="li-card">
        <div class="li-card__head">
          <span class="li-card__index">{{ i + 1 }}</span>
          <v-spacer />
          <span class="li-card__total">{{ minorToDisplay(lineTotalMinor(row), currency) }}</span>
          <v-btn
            icon="mdi-delete-outline"
            variant="text"
            color="error"
            size="small"
            class="px-0"
            :disabled="disabled"
            :aria-label="t('lineItems.removeLine')"
            @click="removeRow(i)"
          />
        </div>
        <v-textarea
          :model-value="row.description"
          :disabled="disabled"
          :label="t('invoices.lineCols.description')"
          density="comfortable"
          hide-details="auto"
          rows="1"
          auto-grow
          aria-label="Line description"
          :rules="[descriptionRule]"
          :error-messages="cellError(i, 'description')"
          :class="['mb-3', { 'placeholder-field': docType }]"
          @update:model-value="(v) => updateRow(i, { description: v })"
          @contextmenu="docType ? onContextMenu($event) : undefined"
        >
          <template v-if="docType" #append-inner>
            <PlaceholderLegend :doc-type="docType" />
          </template>
        </v-textarea>
        <div class="li-card__grid">
          <v-text-field
            :model-value="row.quantity"
            :disabled="disabled"
            :label="t('invoices.lineCols.qty')"
            type="number"
            inputmode="decimal"
            density="comfortable"
            hide-details="auto"
            aria-label="Quantity"
            :rules="[quantityRule]"
            :error-messages="cellError(i, 'quantity')"
            @update:model-value="(v) => updateRow(i, { quantity: v === '' ? null : Number(v) })"
          />
          <v-text-field
            :model-value="formatMajorDisplay(row.unitPriceMajor)"
            :disabled="disabled"
            :label="t('lineItems.unitPrice', { currency })"
            type="text"
            inputmode="decimal"
            density="comfortable"
            hide-details="auto"
            aria-label="Unit price"
            :rules="[unitPriceRule]"
            :error-messages="cellError(i, 'unitPriceMinor')"
            @update:model-value="(v) => onUnitPriceInput(i, v)"
          />
          <v-text-field
            :model-value="row.discountRate"
            :disabled="disabled"
            :label="t('lineItems.discountPct')"
            type="number"
            inputmode="decimal"
            density="comfortable"
            hide-details
            aria-label="Discount rate"
            @update:model-value="(v) => updateRow(i, { discountRate: v === '' ? null : Number(v) })"
          />
          <v-text-field
            :model-value="row.taxRate"
            :disabled="disabled"
            :label="t('lineItems.taxPct')"
            type="number"
            inputmode="decimal"
            density="comfortable"
            hide-details
            aria-label="Tax rate"
            @update:model-value="(v) => updateRow(i, { taxRate: v === '' ? null : Number(v) })"
          />
        </div>
        <v-select
          v-if="natureOn && isZeroRate(row)"
          :model-value="row.nature"
          :items="natureItems"
          :disabled="disabled"
          :label="t('einvoicing.nature.column')"
          density="comfortable"
          hide-details="auto"
          clearable
          class="mt-3"
          :placeholder="t('einvoicing.nature.placeholder')"
          :aria-label="t('einvoicing.nature.column')"
          :error-messages="cellError(i, 'nature')"
          data-test="line-nature"
          @update:model-value="(v) => updateRow(i, { nature: v ?? null })"
        />
      </div>
    </div>

    <v-table v-else density="compact">
      <thead>
        <tr>
          <th style="min-width: 200px">Description</th>
          <th style="width: 90px">Qty</th>
          <th style="width: 160px">Unit price ({{ currency }})</th>
          <th style="width: 90px">Disc %</th>
          <th style="width: 90px">Tax %</th>
          <th v-if="natureOn" style="min-width: 180px">{{ t("einvoicing.nature.column") }}</th>
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
          <td v-if="natureOn">
            <v-select
              v-if="isZeroRate(row)"
              :model-value="row.nature"
              :items="natureItems"
              :disabled="disabled"
              density="compact"
              variant="plain"
              hide-details="auto"
              clearable
              :placeholder="t('einvoicing.nature.placeholder')"
              :aria-label="t('einvoicing.nature.column')"
              :error-messages="cellError(i, 'nature')"
              data-test="line-nature"
              @update:model-value="(v) => updateRow(i, { nature: v ?? null })"
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

    <div class="mt-2" :class="isMobile ? 'li-footer--mobile' : 'd-flex align-center'">
      <v-btn
        color="primary"
        :size="isMobile ? 'large' : 'small'"
        :block="isMobile"
        prepend-icon="mdi-plus"
        :disabled="disabled"
        @click="addRow"
      >
        {{ t("lineItems.addLine") }}
      </v-btn>
      <v-spacer v-if="!isMobile" />
      <div class="text-right" :class="{ 'li-totals--mobile': isMobile }" :style="isMobile ? undefined : 'min-width: 220px'">
        <div class="d-flex justify-space-between text-body-2">
          <span>{{ t("invoices.totals.subtotal") }}</span><span>{{ minorToDisplay(totals.subtotalMinor, currency) }}</span>
        </div>
        <div class="d-flex justify-space-between text-body-2">
          <span>{{ t("lineItems.discount") }}</span><span>{{ minorToDisplay(totals.discountMinor, currency) }}</span>
        </div>
        <div class="d-flex justify-space-between text-body-2">
          <span>{{ t("invoices.totals.tax") }}</span><span>{{ minorToDisplay(totals.taxMinor, currency) }}</span>
        </div>
        <div class="d-flex justify-space-between text-subtitle-1 font-weight-medium">
          <span>{{ t("invoices.totals.total") }}</span><span>{{ minorToDisplay(totals.grandTotalMinor, currency) }}</span>
        </div>
        <div class="text-caption" style="color: var(--v-billy-text-3)">
          {{ t("lineItems.indicative") }}
        </div>
      </div>
    </div>
    <PlaceholderInsertMenu v-if="docType" :state="menuState" :doc-type="docType" @insert="insertToken" />
  </div>
</template>

<style scoped>
/* ── Phone line-item cards ─────────────────────────────────────────────── */
.li-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.li-card {
  border: 1px solid var(--v-billy-border, #e2e4e9);
  border-radius: 14px;
  padding: 8px 12px 14px;
  background: rgb(var(--v-theme-surface));
}
.li-card__head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.li-card__index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 700;
  color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.12);
}
.li-card__total {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.li-card__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.li-footer--mobile {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 12px !important;
}
.li-totals--mobile {
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(var(--v-theme-primary), 0.05);
}
</style>
