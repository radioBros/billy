import { describe, it, expect, vi, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { createI18n } from "vue-i18n";
import { useRecurringProfile, type CreateProfileArgs } from "@/composables/useRecurringProfile";
import en from "@/locales/en.json";

const i18n = createI18n({ legacy: false, locale: "en", messages: { en }, missingWarn: false, fallbackWarn: false });

/** Run `createProfile` inside a component (useI18n needs a setup context) and capture the POST body. */
const postBody = async (args: CreateProfileArgs): Promise<Record<string, unknown>> => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ data: { id: "rp_1" }, meta: {}, error: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  let create!: ReturnType<typeof useRecurringProfile>["createProfile"];
  const Host = defineComponent({
    setup() {
      create = useRecurringProfile().createProfile;
      return () => h("div");
    },
  });
  const wrapper = mount(Host, { global: { plugins: [i18n] } });
  expect(await create(args)).toBeNull();
  wrapper.unmount();
  return bodies[0]!;
};

const base: CreateProfileArgs = {
  documentType: "invoice",
  clientId: "c".repeat(24),
  currency: "EUR",
  lineItems: [{ description: "Hosting", quantity: 1, unitPriceMinor: 1000 }],
  recurrence: { enabled: true, interval: "monthly", intervalCount: 1, startDate: "2026-11-01" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useRecurringProfile.createProfile", () => {
  it("sends bank account, project and payment term so every occurrence carries them", async () => {
    const body = await postBody({ ...base, bankAccountId: "bank_eur", projectId: "p".repeat(24), paymentTermDays: 30 });
    expect(body).toMatchObject({ bankAccountId: "bank_eur", projectId: "p".repeat(24), paymentTermDays: 30 });
  });

  it("sends the expense template for an expense profile", async () => {
    const expense = { category: "Software", vendor: "Hetzner", description: "VPS", billable: true };
    const body = await postBody({ ...base, documentType: "expense", expense });
    expect(body).toMatchObject({ documentType: "expense", expense });
  });

  it("omits empty bank/project/expense (server defaults apply)", async () => {
    const body = await postBody({ ...base, bankAccountId: null, projectId: null });
    expect(body).not.toHaveProperty("bankAccountId");
    expect(body).not.toHaveProperty("projectId");
    expect(body).not.toHaveProperty("expense");
  });
});
