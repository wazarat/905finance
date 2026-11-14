import { describe, expect, it } from "vitest";
import { formatUnits, parseUnits, unitsToDecimalString } from "@/lib/units";

describe("exact asset units", () => {
  it("parses decimal text into the smallest unit", () => {
    expect(parseUnits("100", 2)).toBe(10000n);
    expect(parseUnits("25.5", 2)).toBe(2550n);
    expect(parseUnits("$1,000.25", 2)).toBe(100025n);
    expect(parseUnits("0.000001", 6)).toBe(1n);
    expect(parseUnits("7", 0)).toBe(7n);
  });

  it("handles 18-decimal assets beyond what a float can hold", () => {
    const units = parseUnits("123456789.123456789012345678", 18);
    expect(units).toBe(123456789123456789012345678n);
    expect(unitsToDecimalString(units!, 18)).toBe("123456789.123456789012345678");
  });

  it("is exact where floating point is not", () => {
    expect(parseUnits("0.1", 2)! + parseUnits("0.2", 2)!).toBe(parseUnits("0.3", 2));
  });

  it("rejects anything that is not a plain non-negative amount the asset can represent", () => {
    for (const [text, decimals] of [
      ["", 2],
      ["abc", 2],
      ["-5", 2],
      ["1e3", 2],
      ["1.234", 2],
      ["1.5", 0],
      ["1.2.3", 2],
      ["NaN", 2],
      ["0x10", 2],
    ] as const) {
      expect(parseUnits(text, decimals), `${text} @ ${decimals}`).toBeNull();
    }
  });

  it("formats with separators and the asset code", () => {
    expect(formatUnits(125000n, { code: "USD-TDN", decimals: 2 })).toBe("1,250.00 USD-TDN");
    expect(formatUnits(0n, { code: "SIM-USD", decimals: 2 })).toBe("0.00 SIM-USD");
    expect(formatUnits(42n, { code: "X", decimals: 0 })).toBe("42 X");
  });

  it("round-trips", () => {
    for (const units of [0n, 1n, 99n, 100n, 2550n, 10n ** 30n + 7n]) {
      expect(parseUnits(unitsToDecimalString(units, 2), 2)).toBe(units);
    }
  });
});
