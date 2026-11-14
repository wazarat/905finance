import { describe, expect, it } from "vitest";
import { quoteOrder, shippingCents } from "../../src/checkout";

describe("checkout regressions", () => {
  it("charges shipping on a small order", () => {
    expect(shippingCents(1200)).toBe(599);
  });

  it("ships a large order free", () => {
    expect(shippingCents(12000)).toBe(0);
  });

  it("ships an order of exactly $50.00 free", () => {
    expect(shippingCents(5000)).toBe(0);
  });

  it("totals a typical order as subtotal minus discount plus shipping", () => {
    const quote = quoteOrder([
      { sku: "widget", unitPriceCents: 250, quantity: 4 },
      { sku: "gadget", unitPriceCents: 1999, quantity: 1 },
    ]);
    expect(quote).toEqual({
      subtotalCents: 2999,
      discountCents: 0,
      shippingCents: 599,
      totalCents: 3598,
    });
  });
});
