import { describe, it, expect } from "vitest";
import { buildCloneSeed, toLineItemInputs } from "@/composables/useClonePrefill";

describe("buildCloneSeed", () => {
  it("strips id, document number, status, payments, and issue stamps", () => {
    const invoice = {
      id: "inv_1",
      version: 7,
      invoiceNumber: "INV-0042",
      status: "paid",
      clientId: "cli_1",
      currency: "EUR",
      issueDate: "2026-01-01",
      dueDate: "2026-02-01",
      payments: [{ id: "p1", amountMinor: 1000 }],
      amountPaidMinor: 1000,
      amountDueMinor: 0,
      finalizedAt: "2026-01-02",
      convertedFromQuoteId: "q_1",
      notes: "hi",
      lineItems: [
        { description: "Work", quantity: 2, unitPriceMinor: 500, lineTotalMinor: 1000, taxRate: 0.22 },
      ],
    };

    const seed = buildCloneSeed(invoice as unknown as Record<string, unknown>);

    // The one real bug to avoid: never copy the number/status/id.
    expect(seed.id).toBeUndefined();
    expect(seed.invoiceNumber).toBeUndefined();
    expect(seed.status).toBeUndefined();
    expect(seed.version).toBeUndefined();
    expect(seed.payments).toBeUndefined();
    expect(seed.amountPaidMinor).toBeUndefined();
    expect(seed.amountDueMinor).toBeUndefined();
    expect(seed.finalizedAt).toBeUndefined();
    expect(seed.convertedFromQuoteId).toBeUndefined();

    // Editable content survives.
    expect(seed.clientId).toBe("cli_1");
    expect(seed.currency).toBe("EUR");
    expect(seed.issueDate).toBe("2026-01-01");
    expect(seed.notes).toBe("hi");

    // Line items reduced to raw inputs (computed money fields dropped).
    expect(seed.lineItems).toEqual([
      { description: "Work", quantity: 2, unitPriceMinor: 500, taxRate: 0.22 },
    ]);
  });

  it("strips every per-type document number", () => {
    const seed = buildCloneSeed({
      quoteNumber: "Q-1",
      proformaNumber: "PRO-1",
      creditNoteNumber: "CN-1",
      title: "keep me",
    });
    expect(seed.quoteNumber).toBeUndefined();
    expect(seed.proformaNumber).toBeUndefined();
    expect(seed.creditNoteNumber).toBeUndefined();
    expect(seed.title).toBe("keep me");
  });
});

describe("toLineItemInputs", () => {
  it("keeps only the raw input fields", () => {
    expect(
      toLineItemInputs([
        { description: "A", quantity: 1, unitPriceMinor: 100, lineTotalMinor: 100 },
      ]),
    ).toEqual([{ description: "A", quantity: 1, unitPriceMinor: 100 }]);
  });

  it("returns an empty array for undefined/empty", () => {
    expect(toLineItemInputs(undefined)).toEqual([]);
    expect(toLineItemInputs([])).toEqual([]);
  });
});
