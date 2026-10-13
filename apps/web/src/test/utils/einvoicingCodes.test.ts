import { describe, it, expect } from "vitest";
import { createI18n } from "vue-i18n";
import { NATURA_CODES, PAYMENT_CONDITIONS, PAYMENT_METHODS, TAX_REGIMES } from "@billy/einvoice/codes";
import { codeItems, codeLabel } from "@/utils/einvoicingCodes";
import en from "@/locales/en.json";
import itMessages from "@/locales/it.json";
import es from "@/locales/es.json";
import fr from "@/locales/fr.json";
import de from "@/locales/de.json";
import pt from "@/locales/pt.json";
import ru from "@/locales/ru.json";

const catalogs = { en, it: itMessages, es, fr, de, pt, ru };
const tFor = (locale: keyof typeof catalogs) => {
  const i18n = createI18n({ legacy: false, locale, messages: { [locale]: catalogs[locale] } });
  return (k: string) => i18n.global.t(k) as string;
};

describe("FatturaPA code-list labels", () => {
  it("resolves dotted Natura codes through the nested catalog (N2.1, N6.9)", () => {
    const t = tFor("it");
    expect(codeLabel(t, "natura", "N2.1")).toBe("N2.1 — Non soggette ad IVA (artt. da 7 a 7-septies)");
    expect(codeLabel(t, "natura", "N6.9")).toContain("Inversione contabile");
    expect(codeLabel(t, "natura", "N4")).toBe("N4 — Esenti");
  });

  it("gives Italian-official names for regimes, payment methods and conditions", () => {
    const t = tFor("it");
    expect(codeLabel(t, "taxRegime", "RF19")).toBe("RF19 — Regime forfettario");
    expect(codeLabel(t, "paymentMethod", "MP05")).toBe("MP05 — Bonifico");
    expect(codeLabel(t, "paymentCondition", "TP02")).toBe("TP02 — Pagamento completo");
  });

  for (const locale of Object.keys(catalogs) as (keyof typeof catalogs)[]) {
    it(`every code of every list has a label in ${locale}`, () => {
      const t = tFor(locale);
      const lists = [
        ["taxRegime", TAX_REGIMES],
        ["paymentMethod", PAYMENT_METHODS],
        ["paymentCondition", PAYMENT_CONDITIONS],
        ["natura", NATURA_CODES],
      ] as const;
      for (const [list, codes] of lists) {
        for (const code of codes) {
          // A missing key falls back to the bare code — which must not happen.
          expect(codeLabel(t, list, code), `${locale} ${list}.${code}`).not.toBe(code);
        }
        expect(codeItems(t, list)).toHaveLength(codes.length);
      }
    });
  }
});
