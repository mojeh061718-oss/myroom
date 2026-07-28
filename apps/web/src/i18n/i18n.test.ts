import { describe, expect, it } from "vitest";
import { en } from "./en.js";
import { MESSAGE_KEYS, missingKeys, selectLocale, t } from "./index.js";

describe("localization scaffold (docs/09 M6)", () => {
  it("returns the English copy for a known key", () => {
    expect(t("privacy.title")).toBe(en["privacy.title"]);
  });

  it("substitutes named parameters rather than concatenating", () => {
    // Word order is the first thing that changes in another language, so
    // parameters are named and positioned by the catalogue, not by the caller.
    expect(t("recon.fromScan", { count: 3 })).toBe("3 pieces came from your scan, at the sizes it measured.");
    expect(t("notify.roomReadyBody", { name: "Living room" })).toBe("Living room is built and waiting.");
  });

  it("leaves an unknown placeholder visible instead of blanking it", () => {
    expect(t("recon.fromScan", {})).toContain("{count}");
  });

  it("falls back to English for an unknown locale, and matches by primary subtag", () => {
    expect(selectLocale(["fr-CA", "de"])).toBe("en");
    expect(selectLocale(["en-GB"])).toBe("en");
    expect(t("recon.ready")).toBe("Your room is ready");
  });

  it("can tell a translator exactly what a new catalogue is missing", () => {
    expect(missingKeys({ ...en })).toEqual([]);
    const partial = { ...en } as Record<string, string>;
    delete partial["privacy.title"];
    expect(missingKeys(partial as never)).toEqual(["privacy.title"]);
  });

  it("has no empty strings, and no key used as its own value", () => {
    for (const key of MESSAGE_KEYS) {
      expect(en[key].length).toBeGreaterThan(0);
      expect(en[key]).not.toBe(key);
    }
  });
});
