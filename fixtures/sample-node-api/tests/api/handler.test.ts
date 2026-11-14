import { describe, expect, it } from "vitest";
import { handleRequest } from "../../src/handler";

describe("POST /quote", () => {
  it("returns a quote for a valid order", () => {
    const response = handleRequest({
      method: "POST",
      path: "/quote",
      body: { items: [{ sku: "widget", unitPriceCents: 250, quantity: 4 }] },
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      subtotalCents: 1000,
      discountCents: 0,
      shippingCents: 599,
      totalCents: 1599,
    });
  });

  it("rejects a malformed order with 400", () => {
    const response = handleRequest({ method: "POST", path: "/quote", body: { items: [{ sku: "" }] } });
    expect(response.status).toBe(400);
  });

  it("answers 404 for an unknown path and 405 for the wrong method", () => {
    expect(handleRequest({ method: "GET", path: "/missing" }).status).toBe(404);
    expect(handleRequest({ method: "GET", path: "/quote" }).status).toBe(405);
  });
});
