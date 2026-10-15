/**
 * Shared recurring-profile create wiring for the invoice / proforma / expense
 * CREATE forms (DRY). Each form:
 *   1. creates its one-off document as before (that is the FIRST occurrence), then
 *   2. if the RecurringToggle is ON, calls `createProfile()` here to POST a
 *      recurring profile of the matching `documentType`. The backend worker then
 *      generates every SUBSEQUENT occurrence on schedule.
 *
 * The composable owns the success-snackbar state (text + a "view list" link) so
 * all three forms present recurrence success identically, and returns a typed
 * error string on failure (the one-off doc already exists at that point — the
 * caller surfaces the profile error without implying the doc was lost).
 */
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/api/client";
import { apiErrorReason } from "@/utils/validationMessages";
import type {
  LineItemInput,
  RecurrenceConfig,
  RecurringAutoSend,
  RecurringDocumentType,
  RecurringExpenseTemplate,
  RecurringProfile,
} from "@/types/domain";

export interface CreateProfileArgs {
  documentType: RecurringDocumentType;
  clientId: string;
  currency: string;
  lineItems: LineItemInput[];
  recurrence: RecurrenceConfig;
  subject?: string | null;
  notes?: string | null;
  /** Days from issue to due on each generated document (the source form's
   *  issue→due gap). Omit ⇒ server default (7). */
  paymentTermDays?: number | null;
  /** Bank account (business-settings id) snapshotted onto each generated
   *  invoice/proforma. Omit ⇒ the single account when exactly one exists. */
  bankAccountId?: string | null;
  /** Project copied onto every generated document. */
  projectId?: string | null;
  /** Expense profiles: category/vendor/description/billable of each expense. */
  expense?: RecurringExpenseTemplate | null;
  /** Optional auto-send config set at creation; usually configured later on the
   *  profile's detail page. Omit ⇒ no auto-send. */
  autoSend?: RecurringAutoSend | null;
}

export const useRecurringProfile = () => {
  const { t } = useI18n();

  const snackbar = ref(false);
  const snackbarText = ref("");

  /**
   * POST /v1/recurring-profiles. Returns `null` on success (and raises the
   * snackbar) or a display error string on failure — never throws.
   */
  async function createProfile(args: CreateProfileArgs): Promise<string | null> {
    const { recurrence } = args;
    const payload: Record<string, unknown> = {
      documentType: args.documentType,
      clientId: args.clientId,
      currency: args.currency,
      interval: recurrence.interval,
      intervalCount: Number(recurrence.intervalCount),
      // "Every Nth of month" anchor — monthly-family cadences only.
      dayOfMonth: recurrence.dayOfMonth ?? null,
      startDate: recurrence.startDate,
      endDate: recurrence.endDate ?? null,
      maxOccurrences:
        recurrence.maxOccurrences === null || recurrence.maxOccurrences === undefined
          ? null
          : Number(recurrence.maxOccurrences),
      lineItems: args.lineItems,
      subject: args.subject ?? null,
      notes: args.notes ?? null,
      ...(args.paymentTermDays != null ? { paymentTermDays: args.paymentTermDays } : {}),
      ...(args.bankAccountId ? { bankAccountId: args.bankAccountId } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
      ...(args.expense ? { expense: args.expense } : {}),
      // Auto-send set on the toggle wins; explicit arg kept for callers that
      // configure it separately.
      ...(args.autoSend ?? recurrence.autoSend
        ? { autoSend: args.autoSend ?? recurrence.autoSend }
        : {}),
      // SdI submission of each generated invoice (only present while e-invoicing is on).
      ...(recurrence.einvoice ? { einvoice: recurrence.einvoice } : {}),
    };
    try {
      await api.post<RecurringProfile>("/v1/recurring-profiles", payload);
      snackbarText.value = t("recurring.toggle.created");
      snackbar.value = true;
      return null;
    } catch (err) {
      return err instanceof ApiError
        ? t("recurring.toggle.createError", { code: apiErrorReason(err) })
        : t("recurring.toggle.createErrorGeneric");
    }
  }

  return { snackbar, snackbarText, createProfile };
};
