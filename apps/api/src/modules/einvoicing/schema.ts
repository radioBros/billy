import { z } from "zod";
import { NATURA_CODES, PAYMENT_CONDITIONS, PAYMENT_METHODS, TAX_REGIMES } from "@billy/einvoice";

const decimal2 = z.string().regex(/^\d{1,6}(\.\d{1,2})?$/u, { message: "decimal.invalid" });

/** PATCH /settings/einvoicing — editable fields only (secrets are write-only below). */
export const EInvoicingSettingsUpdateSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(["managed", "manual"]),
    apiBaseUrl: z.string().trim().url({ message: "url.invalid" }).nullable(),
    taxRegime: z.enum(TAX_REGIMES),
    offerStepAfterFinalize: z.boolean(),
    scheduledDefaultSubmit: z.boolean(),
    recurringDefaultSubmit: z.boolean(),
    defaultPaymentConditions: z.enum(PAYMENT_CONDITIONS),
    defaultPaymentMethod: z.enum(PAYMENT_METHODS),
    defaultZeroRateNature: z.enum(NATURA_CODES).nullable(),
    zeroRateLawReference: z.string().trim().max(100).nullable(),
    bollo: z.object({ mode: z.enum(["auto", "off"]), threshold: decimal2, amount: decimal2 }).partial(),
    creditNoteNumberPrefix: z.string().trim().min(1).max(8),
    sendDeadlineDays: z.number().int().min(1).max(60),
    // Manual mode, write-only: the tenant API key and seller id the PASSO operator gave you.
    apiKey: z.string().trim().min(8).max(200),
    passoSellerId: z.string().trim().min(1).max(100),
  })
  .partial();
export type EInvoicingSettingsUpdateInput = z.infer<typeof EInvoicingSettingsUpdateSchema>;

const pecConfig = z.object({
  smtpHost: z.string().trim().min(1),
  smtpPort: z.coerce.number().int().positive(),
  imapHost: z.string().trim().min(1),
  imapPort: z.coerce.number().int().positive(),
  user: z.string().trim().min(1),
  password: z.string().min(1),
});
const openapiConfig = z.object({
  token: z.string().trim().min(1),
  baseUrl: z.enum(["https://sdi.openapi.it", "https://test.sdi.openapi.it"]),
  requestSigning: z.boolean().default(false),
});

/** PUT /settings/einvoicing/channel */
export const ChannelUpdateSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pec"), config: pecConfig }),
  z.object({ type: z.literal("openapi"), config: openapiConfig }),
  z.object({ type: z.literal("mock"), config: z.object({}).passthrough().default({}) }),
]);
export type ChannelUpdateInput = z.infer<typeof ChannelUpdateSchema>;

/** POST /settings/einvoicing/channel/test — PEC connection test + a real test email. */
export const PecTestSchema = z.object({ config: pecConfig, to: z.string().trim().email({ message: "email.invalid" }) });
export type PecTestInput = z.infer<typeof PecTestSchema>;

/** POST /settings/einvoicing/channel/test-openapi — token + seller registry + signing check. */
export const OpenapiTestSchema = z.object({ config: openapiConfig });
export type OpenapiTestInput = z.infer<typeof OpenapiTestSchema>;

export const DocFlagSchema = z.object({ submitOnFinalize: z.boolean() });
