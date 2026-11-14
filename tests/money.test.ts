import { describe, expect, it } from "vitest";
import { formatMoney, minorToDecimalString, parseMoneyToMinor } from "@/lib/money";

describe("money", () => {
  it("parses decimals into integer minor units", () => {
    expect(parseMoneyToMinor("25")).toBe(2500);
    expect(parseMoneyToMinor("25.5")).toBe(2550);
    expect(parseMoneyToMinor("25.50")).toBe(2550);
    expect(parseMoneyToMinor("$1,250.05")).toBe(125005);
    expect(parseMoneyToMinor("0")).toBe(0);
  });

  it("is exact where floating point is not", () => {
    // 0.1 + 0.2 !== 0.3 in floating point; minor units add exactly.
    expect(parseMoneyToMinor("0.10")! + parseMoneyToMinor("0.20")!).toBe(parseMoneyToMinor("0.30"));
    expect(parseMoneyToMinor("19.99")).toBe(1999);
    expect(parseMoneyToMinor("4.35")).toBe(435);
  });

  it("rejects anything that is not a plain non-negative amount", () => {
    for (const bad of ["", "abc", "-5", "1.234", "1e3", "1.2.3", " ", "NaN", "12345678901"]) {
      expect(parseMoneyToMinor(bad), bad).toBeNull();
    }
  });

  it("round-trips minor units through formatting", () => {
    for (const minor of [0, 1, 99, 100, 2550, 125005, 100000000]) {
      expect(parseMoneyToMinor(minorToDecimalString(minor))).toBe(minor);
    }
    expect(formatMoney(2550)).toBe("$25.50");
    expect(formatMoney(125005)).toBe("$1,250.05");
    expect(formatMoney(500, "USDT")).toBe("5.00 USDT");
  });

  it("refuses non-integer or negative minor amounts", () => {
    expect(() => minorToDecimalString(1.5)).toThrow();
    expect(() => minorToDecimalString(-1)).toThrow();
  });
});
