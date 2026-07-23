import { describe, it, expect } from "vitest";
import { resolveLocalized, isLocalizedMap, toLocalizedMap } from "@billy/shared";

describe("resolveLocalized — tolerant read (no migration needed)", () => {
  it("returns a legacy plain string as-is for any locale", () => {
    expect(resolveLocalized("Grazie!", "de")).toBe("Grazie!");
    expect(resolveLocalized("Grazie!", "en", "it")).toBe("Grazie!");
  });

  it("picks the requested locale from a map", () => {
    const f = { en: "Thanks", it: "Grazie", de: "Danke" };
    expect(resolveLocalized(f, "it")).toBe("Grazie");
    expect(resolveLocalized(f, "de")).toBe("Danke");
  });

  it("falls back locale → companyDefault → en → first-non-empty", () => {
    const f = { en: "Thanks", it: "Grazie" };
    // fr missing → company default it
    expect(resolveLocalized(f, "fr", "it")).toBe("Grazie");
    // fr missing, company default (es) also missing → en
    expect(resolveLocalized(f, "fr", "es")).toBe("Thanks");
    // only a non-en/non-default entry present → first non-empty
    expect(resolveLocalized({ pt: "Obrigado" }, "fr", "es")).toBe("Obrigado");
  });

  it("treats blank/whitespace map entries as missing", () => {
    expect(resolveLocalized({ it: "   ", en: "Thanks" }, "it")).toBe("Thanks");
  });

  it("returns empty string for null/undefined/empty map", () => {
    expect(resolveLocalized(null, "it")).toBe("");
    expect(resolveLocalized(undefined, "it")).toBe("");
    expect(resolveLocalized({}, "it")).toBe("");
  });

  it("normalizes region tags (it-IT → it)", () => {
    expect(resolveLocalized({ it: "Grazie" }, "it-IT")).toBe("Grazie");
  });
});

describe("isLocalizedMap / toLocalizedMap", () => {
  it("isLocalizedMap distinguishes maps from strings/null", () => {
    expect(isLocalizedMap({ en: "x" })).toBe(true);
    expect(isLocalizedMap("x")).toBe(false);
    expect(isLocalizedMap(null)).toBe(false);
  });
  it("toLocalizedMap seeds a legacy string under the seed locale", () => {
    expect(toLocalizedMap("hello", "en")).toEqual({ en: "hello" });
    expect(toLocalizedMap({ it: "ciao" })).toEqual({ it: "ciao" });
    expect(toLocalizedMap(null)).toEqual({});
    expect(toLocalizedMap("")).toEqual({});
  });
});
