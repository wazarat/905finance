import { describe, expect, it } from "vitest";
import { bulkDiscountCents, lineTotalCents, subtotalCents } from "../../src/cart";

describe("cart", () => {
  it("multiplies unit price by quantity for a line total", () => {
    expect(lineTotalCents({ sku: "widget", unitPriceCents: 250, quantity: 4 })).toBe(1000);
  });

  it("has a zero subtotal when the cart is empty", () => {
    expect(subtotalCents([])).toBe(0);
  });

  it("adds up the line totals for the subtotal", () => {
    expect(
      subtotalCents([
        { sku: "widget", unitPriceCents: 250, quantity: 4 },
        { sku: "gadget", unitPriceCents: 1999, quantity: 1 },
      ]),
    ).toBe(2999);
  });

  it("gives no bulk discount below ten units", () => {
    expect(bulkDiscountCents({ sku: "widget", unitPriceCents: 250, quantity: 9 })).toBe(0);
  });

  it("gives the bulk discount on twelve units", () => {
    expect(bulkDiscountCents({ sku: "widget", unitPriceCents: 250, quantity: 12 })).toBe(300);
  });

  it("gives the bulk discount on exactly ten units", () => {
    expect(bulkDiscountCents({ sku: "widget", unitPriceCents: 250, quantity: 10 })).toBe(250);
  });
});
