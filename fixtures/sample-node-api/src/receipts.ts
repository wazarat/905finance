import { readFileSync } from "node:fs";
import path from "node:path";

const RECEIPT_DIR = "/var/data/receipts";

/** The stored receipt for an order, by the order id in the request. */
export function loadReceipt(orderId: string): string {
  return readFileSync(path.join(RECEIPT_DIR, `${orderId}.txt`), "utf8");
}
