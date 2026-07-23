import { describe, it, expect } from "vitest";
import { SUPPORTED_LOCALES } from "@/plugins/i18n";
import en from "@/locales/en.json";
import es from "@/locales/es.json";
import itMessages from "@/locales/it.json";
import fr from "@/locales/fr.json";
import ru from "@/locales/ru.json";
import pt from "@/locales/pt.json";
import de from "@/locales/de.json";

type Catalog = Record<string, unknown>;

const catalogs: Record<string, Catalog> = { en, es, it: itMessages, fr, ru, pt, de };

const leafKeys = (obj: Catalog, prefix = ""): string[] => {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") {
      out.push(...leafKeys(v as Catalog, path));
    } else {
      out.push(path);
    }
  }
  return out.sort();
};

const placeholders = (value: unknown): string[] => {
  if (typeof value !== "string") return [];
  return (value.match(/\{[^}]+\}/gu) ?? []).sort();
};

const leafValue = (obj: Catalog, path: string): unknown => {
  return path.split(".").reduce<unknown>((acc, seg) => {
    if (acc !== null && typeof acc === "object") return (acc as Catalog)[seg];
    return undefined;
  }, obj);
};

const baseKeys = leafKeys(en);

describe("locale catalog parity", () => {
  it("every SUPPORTED_LOCALES code has a message catalog", () => {
    for (const loc of SUPPORTED_LOCALES) {
      expect(catalogs[loc], `missing catalog for ${loc}`).toBeDefined();
    }
    expect(Object.keys(catalogs).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it("en.json defines 1050 leaf keys", () => {
    expect(baseKeys.length).toBe(1050);
  });

  for (const loc of Object.keys(catalogs)) {
    it(`${loc}.json has the exact same leaf-key paths as en.json`, () => {
      expect(leafKeys(catalogs[loc]!)).toEqual(baseKeys);
    });

    it(`${loc}.json preserves the same interpolation placeholders as en.json`, () => {
      for (const key of baseKeys) {
        expect(
          placeholders(leafValue(catalogs[loc]!, key)),
          `placeholder mismatch at "${key}" in ${loc}.json`,
        ).toEqual(placeholders(leafValue(en, key)));
      }
    });
  }
});
