import { discountCents, subtotalCents, type LineItem } from "./cart";

/** Orders of this amount or more, after discounts, ship free. */
export const FREE_SHIPPING_THRESHOLD_CENTS = 5000;
export const SHIPPING_CENTS = 599;

export function shippingCents(discountedSubtotalCents: number): number {
  // Deliberate defect: `>` charges shipping on an order of exactly the threshold.
  return discountedSubtotalCents > FREE_SHIPPING_THRESHOLD_CENTS ? 0 : SHIPPING_CENTS;
}

export type OrderQuote = {
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  totalCents: number;
};

export function quoteOrder(items: LineItem[]): OrderQuote {
  const subtotal = subtotalCents(items);
  const discount = discountCents(items);
  const shipping = shippingCents(subtotal - discount);
  return {
    subtotalCents: subtotal,
    discountCents: discount,
    shippingCents: shipping,
    totalCents: subtotal - discount + shipping,
  };
}
