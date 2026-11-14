import { quoteOrder } from "./checkout";
import type { LineItem } from "./cart";

export type ApiRequest = { method: string; path: string; body?: unknown };
export type ApiResponse = { status: number; body: unknown };

function isLineItem(value: unknown): value is LineItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.sku === "string" &&
    item.sku.length > 0 &&
    Number.isInteger(item.unitPriceCents) &&
    (item.unitPriceCents as number) >= 0 &&
    Number.isInteger(item.quantity) &&
    (item.quantity as number) > 0
  );
}

/** The service's request handler, callable in-process so tests need no network. */
export function handleRequest(request: ApiRequest): ApiResponse {
  if (request.path !== "/quote") {
    return { status: 404, body: { error: "Not found" } };
  }
  if (request.method !== "POST") {
    return { status: 405, body: { error: "Method not allowed" } };
  }
  const items = (request.body as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items) || items.length === 0 || !items.every(isLineItem)) {
    return { status: 400, body: { error: "items must be a non-empty list of line items" } };
  }
  return { status: 200, body: quoteOrder(items) };
}
