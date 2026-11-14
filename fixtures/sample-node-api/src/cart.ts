export type LineItem = { sku: string; unitPriceCents: number; quantity: number };

/** Units of one item at which the bulk discount applies. */
export const BULK_DISCOUNT_MIN_QUANTITY = 10;

export function lineTotalCents(item: LineItem): number {
  return item.unitPriceCents * item.quantity;
}

export function subtotalCents(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + lineTotalCents(item), 0);
}

/** 10% off a line of BULK_DISCOUNT_MIN_QUANTITY units or more. */
export function bulkDiscountCents(item: LineItem): number {
  // Deliberate defect: `>` leaves out an order of exactly the minimum quantity.
  if (item.quantity > BULK_DISCOUNT_MIN_QUANTITY) {
    return Math.round(lineTotalCents(item) * 0.1);
  }
  return 0;
}

export function discountCents(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + bulkDiscountCents(item), 0);
}
