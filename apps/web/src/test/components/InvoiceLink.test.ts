import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { createI18n } from "vue-i18n";
import en from "@/locales/en.json";
import InvoiceLink from "@/components/InvoiceLink.vue";

// `invoices.viewInvoice` is new (merged into the locale files separately) — seed it here.
const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: { en: { ...en, invoices: { ...en.invoices, viewInvoice: "View invoice" } } },
  missingWarn: false,
  fallbackWarn: false,
});

/** RouterLink stand-in: renders the slot and exposes the target for assertions. */
const RouterLinkStub = defineComponent({
  props: { to: { type: Object, required: true } },
  setup: (props, { slots }) => () => h("a", { "data-to": JSON.stringify(props.to) }, slots.default?.()),
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const mountLink = (props: { invoiceId: string; number?: string | null }) =>
  mount(InvoiceLink, { props, global: { plugins: [i18n], stubs: { RouterLink: RouterLinkStub } } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v1/invoices/inv_num")) return jsonResponse({ data: { id: "inv_num", invoiceNumber: "INV-2026-0042" }, meta: {}, error: null });
    if (url.includes("/v1/invoices/inv_draft")) return jsonResponse({ data: { id: "inv_draft", invoiceNumber: null }, meta: {}, error: null });
    return jsonResponse({ data: null, meta: {}, error: { code: "NOT_FOUND", message: "nope" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("InvoiceLink", () => {
  it("uses the known number without fetching, and links to the invoice detail", async () => {
    const wrapper = mountLink({ invoiceId: "inv_num", number: "INV-1" });
    await flushPromises();
    expect(wrapper.text()).toBe("INV-1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(wrapper.find("a").attributes("data-to")!)).toEqual({ name: "invoice-detail", params: { id: "inv_num" } });
  });

  it("fetches the number when only the id is known — never shows the raw id", async () => {
    const wrapper = mountLink({ invoiceId: "inv_num" });
    expect(wrapper.text()).not.toContain("inv_num");
    await flushPromises();
    expect(wrapper.text()).toBe("INV-2026-0042");
  });

  it("falls back to a neutral label for an unnumbered or unreadable invoice", async () => {
    const draft = mountLink({ invoiceId: "inv_draft" });
    const missing = mountLink({ invoiceId: "inv_gone" });
    await flushPromises();
    expect(draft.text()).toBe("View invoice");
    expect(missing.text()).toBe("View invoice");
    expect(missing.text()).not.toContain("inv_gone");
  });
});
