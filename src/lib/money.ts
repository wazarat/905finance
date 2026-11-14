/**
 * Money helpers. Amounts are always integer minor units (cents for USD).
 * Nothing here uses floating-point arithmetic on monetary values.
 */

const MINOR_DIGITS = 2;
const DECIMAL_PATTERN = /^\d{1,9}(\.\d{1,2})?$/;

/**
 * Parse a user-entered decimal string such as "25", "25.5" or "25.50" into
 * minor units. Returns null for anything that is not a plain non-negative
 * decimal with at most two fractional digits.
 */
export function parseMoneyToMinor(input: string): number | null {
  const value = input.trim().replace(/^\$/, "").replaceAll(",", "");
  if (!DECIMAL_PATTERN.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(MINOR_DIGITS, "0"));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(minor);
}

/** Format minor units as a plain decimal string, e.g. 2550 -> "25.50". */
export function minorToDecimalString(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new RangeError("minor must be a non-negative safe integer");
  }
  const value = BigInt(minor);
  const whole = value / 100n;
  const fraction = (value % 100n).toString().padStart(MINOR_DIGITS, "0");
  return `${whole}.${fraction}`;
}

/** Format minor units for display, e.g. 2550 USD -> "$25.50". */
export function formatMoney(minor: number, currency = "USD"): string {
  const decimal = minorToDecimalString(minor);
  const [whole, fraction] = decimal.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const amount = `${grouped}.${fraction}`;
  return currency === "USD" ? `$${amount}` : `${amount} ${currency}`;
}
