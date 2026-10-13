import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { createPinia, setActivePinia } from "pinia";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import { i18n } from "@/plugins/i18n";
import InvoicesList from "@/pages/invoices/InvoicesList.vue";
import CreditNotesList from "@/pages/credit-notes/CreditNotesList.vue";
import EInvoiceNotSentCard from "@/components/dashboard/EInvoiceNotSentCard.vue";
import * as apiClient from "@/api/client";
import { polyfillBrowser } from "@/test/helpers/einvoicing";

const vuetify = createVuetify({ components, directives });
const push = vi.fn();
vi.mock("vue-router", () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({ params: {}, query: {} }),
}));

beforeAll(polyfillBrowser);
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  setActivePinia(createPinia());
  i18n.global.locale.value = "en";
  push.mockClear();
});
let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.restoreAllMocks();
});

const mockApi = (summary: unknown, rows: unknown[] = []) => {
  vi.spyOn(apiClient.api, "get").mockImplementation((path: string) => {
    if (path === "/v1/einvoicing/summary") return Promise.resolve(summary);
    if (path.includes("/years")) return Promise.resolve({ minYear: 2026, maxYear: 2026 });
    if (path.includes("monthly-totals")) return Promise.resolve([]);
    return Promise.resolve({});
  });
  return vi.spyOn(apiClient.api, "list").mockResolvedValue({ data: rows, meta: { total: rows.length } } as never);
};

const ROWS = [
  { id: "i1", invoiceNumber: "2026-1", clientId: "c1", status: "sent", currency: "EUR", issueDate: "2026-10-01", dueDate: "2026-10-31", grandTotalMinor: 1000, amountDueMinor: 1000, einvoice: { status: "rejected", legallyIssued: false } },
  { id: "i2", invoiceNumber: "2026-2", clientId: "c1", status: "paid", currency: "EUR", issueDate: "2026-10-02", dueDate: "2026-10-31", grandTotalMinor: 1000, amountDueMinor: 0, einvoice: { status: "delivered", legallyIssued: true } },
];

describe("invoice list — SdI column + filter", () => {
  it("enabled: shows the badge column and the filter, and passes einvoiceStatus", async () => {
    const list = mockApi({ enabled: true, notSent: 0, overdue: 0, items: [] }, ROWS);
    wrapper = mount(InvoicesList, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();

    expect(wrapper.text()).toContain("SdI");
    const chips = wrapper.findAll('[data-test="einvoice-status-chip"]').map((c) => c.text());
    expect([...chips].sort()).toEqual(["Delivered", "Rejected by SdI"]);
    expect(wrapper.find('[data-test="einvoice-status-filter"]').exists()).toBe(true);

    (wrapper.vm as unknown as { einvoiceFilter: string }).einvoiceFilter = "not_sent";
    await flushPromises();
    const last = list.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(last.einvoiceStatus).toBe("not_sent");
  });

  it("disabled: no column, no filter, no einvoiceStatus param", async () => {
    const list = mockApi({ enabled: false, notSent: 0, overdue: 0, items: [] }, ROWS.map(({ einvoice: _e, ...r }) => r));
    wrapper = mount(InvoicesList, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();
    expect(wrapper.find('[data-test="einvoice-status-chip"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="einvoice-status-filter"]').exists()).toBe(false);
    (wrapper.vm as unknown as { einvoiceFilter: string }).einvoiceFilter = "failed";
    await flushPromises();
    const last = list.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(last.einvoiceStatus).toBeUndefined();
  });

  it("legally issued invoices have no Void row action", async () => {
    mockApi({ enabled: true, notSent: 0, overdue: 0, items: [] }, ROWS);
    wrapper = mount(InvoicesList, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();
    const vm = wrapper.vm as unknown as { rowActions: (i: unknown) => { key: string }[] };
    expect(vm.rowActions(ROWS[0]).some((a) => a.key === "void")).toBe(true);
    expect(vm.rowActions(ROWS[1]).some((a) => a.key === "void")).toBe(false);
  });
});

describe("credit-note list — SdI filter", () => {
  it("enabled: filter present and sent as einvoiceStatus", async () => {
    const list = mockApi({ enabled: true, notSent: 0, overdue: 0, items: [] }, [
      { id: "n1", creditNoteNumber: "CN-1", clientId: "c1", status: "issued", currency: "EUR", issueDate: "2026-10-01", grandTotalMinor: 500, einvoice: { status: "queued", legallyIssued: false } },
    ]);
    wrapper = mount(CreditNotesList, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();
    expect(wrapper.find('[data-test="einvoice-status-filter"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="einvoice-status-chip"]').text()).toBe("Queued");
    (wrapper.vm as unknown as { einvoiceFilter: string }).einvoiceFilter = "failed";
    await flushPromises();
    expect((list.mock.calls.at(-1)![1] as Record<string, unknown>).einvoiceStatus).toBe("failed");
  });
});

describe("dashboard — documents not yet sent to SdI", () => {
  const ITEMS = [
    { kind: "invoice", id: "i1", number: "2026-1", clientName: "Rossi", issueDate: "2026-09-01", dueBy: "2026-09-13", overdue: true, status: "not_sent" },
    { kind: "credit_note", id: "n1", number: "NC-1", clientName: "Bianchi", issueDate: "2026-10-01", dueBy: "2026-10-13", overdue: false, status: "not_sent" },
    { kind: "invoice", id: "i3", number: "2026-3", clientName: "Verdi", issueDate: "2026-10-01", dueBy: "2026-10-13", overdue: false, status: "rejected" },
  ];

  it("enabled with pending items: lists them, highlights overdue + needs-attention, and opens the document", async () => {
    mockApi({ enabled: true, notSent: 2, problems: 1, overdue: 1, items: ITEMS });
    wrapper = mount(EInvoiceNotSentCard, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();
    const card = wrapper.find('[data-test="einvoice-not-sent-card"]');
    expect(card.exists()).toBe(true);
    expect(card.text()).toContain("Invoices not yet sent to SdI");
    expect(wrapper.find('[data-test="einvoice-overdue-count"]').text()).toContain("1");
    expect(wrapper.find('[data-test="einvoice-problems-count"]').text()).toContain("1");
    expect(wrapper.find('[data-test="einvoice-row-i1"]').classes()).toContain("einvoice-row--overdue");
    expect(wrapper.find('[data-test="einvoice-row-n1"]').classes()).not.toContain("einvoice-row--overdue");
    expect(wrapper.find('[data-test="einvoice-attention-i3"]').text()).toBe("Rejected by SdI");

    await wrapper.find('[data-test="einvoice-row-n1"]').trigger("click");
    expect(push).toHaveBeenCalledWith({ name: "credit-note-detail", params: { id: "n1" } });
  });

  it("hidden when disabled, and when nothing is pending", async () => {
    mockApi({ enabled: false, notSent: 3, overdue: 0, items: ITEMS });
    wrapper = mount(EInvoiceNotSentCard, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();
    expect(wrapper.find('[data-test="einvoice-not-sent-card"]').exists()).toBe(false);
    wrapper.unmount();

    setActivePinia(createPinia());
    mockApi({ enabled: true, notSent: 0, problems: 0, overdue: 0, items: [] });
    wrapper = mount(EInvoiceNotSentCard, { global: { plugins: [vuetify, i18n] } });
    await flushPromises();
    expect(wrapper.find('[data-test="einvoice-not-sent-card"]').exists()).toBe(false);
  });
});
