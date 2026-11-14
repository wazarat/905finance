/**
 * Exact amounts in an asset's smallest unit, as bigint. Conversion to and from
 * decimal text is done with integer arithmetic only; no value here is ever a
 * floating-point number.
 */

export type AssetInfo = { code: string; decimals: number };

/**
 * Parse user-entered decimal text ("100", "25.50", "1,000") into units.
 * Returns null unless it is a plain non-negative decimal with no more
 * fractional digits than the asset has.
 */
export function parseUnits(input: string, decimals: number): bigint | null {
  const value = input.trim().replace(/^\$/, "").replaceAll(",", "");
  if (!/^\d{1,30}(\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Plain decimal text for an amount, e.g. 2550n with 2 decimals -> "25.50". */
export function unitsToDecimalString(units: bigint, decimals: number): string {
  if (units < 0n) throw new RangeError("units must not be negative");
  const base = 10n ** BigInt(decimals);
  const whole = units / base;
  if (decimals === 0) return whole.toString();
  const fraction = (units % base).toString().padStart(decimals, "0");
  return `${whole}.${fraction}`;
}

/** Display text with thousands separators and the asset code, e.g. "1,250.00 USD-TDN". */
export function formatUnits(units: bigint, asset: AssetInfo): string {
  const [whole, fraction] = unitsToDecimalString(units, asset.decimals).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${fraction === undefined ? grouped : `${grouped}.${fraction}`} ${asset.code}`;
}
