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
import type { LineItemInput, RecurrenceConfig, RecurringDocumentType, RecurringProfile } from "@/types/domain";

export interface CreateProfileArgs {
  documentType: RecurringDocumentType;
  clientId: string;
  currency: string;
  lineItems: LineItemInput[];
  recurrence: RecurrenceConfig;
  subject?: string | null;
  notes?: string | null;
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
      startDate: recurrence.startDate,
      endDate: recurrence.endDate ?? null,
      maxOccurrences:
        recurrence.maxOccurrences === null || recurrence.maxOccurrences === undefined
          ? null
          : Number(recurrence.maxOccurrences),
      lineItems: args.lineItems,
      subject: args.subject ?? null,
      notes: args.notes ?? null,
    };
    try {
      await api.post<RecurringProfile>("/v1/recurring-profiles", payload);
      snackbarText.value = t("recurring.toggle.created");
      snackbar.value = true;
      return null;
    } catch (err) {
      return err instanceof ApiError
        ? t("recurring.toggle.createError", { code: err.code })
        : t("recurring.toggle.createErrorGeneric");
    }
  }

  return { snackbar, snackbarText, createProfile };
};
