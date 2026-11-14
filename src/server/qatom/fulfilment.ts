import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db/client";
import { checkAgentCommunication } from "../agent-gate";
import type { SellerReply } from "../agent/transport";
import { answerAsSampleSeller } from "../seller-agent/service";
import {
  QATOM_ACCOUNT_TOKEN_URL,
  QATOM_PURCHASE_URL,
  fetchQatom,
  qatomAccountCredentials,
  qatomFulfilmentToken,
  qatomItemFor,
} from "./config";
import { sameText } from "./crypto";
import { openMessage, sealReply, type ChannelResponse } from "./envelope";

const { sellerProfiles, qatomDispatches } = schema;

/**
 * The seller's endpoint for messages delivered by Qatom, for the platform's
 * sample sellers.
 *
 * A delivery is believed only after every one of these holds:
 *
 * 1. It presents the secret set on the catalog item, so it came from Qatom
 *    (or from someone holding that secret).
 * 2. It names a Qatom transaction; where the seller account's credentials
 *    are configured, Qatom itself confirms the transaction is a settled sale
 *    of this seller's item, for nothing.
 * 3. The message is signed by the engagement it names, and is recent.
 * 4. Neither the transaction nor the message has been served before.
 * 5. The engagement is active and this seller is the one it selected.
 *
 * Only then is the message handed to the seller's agent, which runs its own
 * checks on the content (including confirming any payment itself).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DispatchOutcome =
  /** Not a delivery this endpoint recognises. Answered as if nothing is here. */
  | { kind: "not_found" }
  /** A recognised delivery. Always answered 200, because Qatom drops the body of anything else. */
  | { kind: "answered"; body: ChannelResponse | { ok: false; status: "rejected"; reason: string } };

const rejected = (reason: string): DispatchOutcome => ({
  kind: "answered",
  body: { ok: false, status: "rejected", reason },
});

let accountToken: { value: string; expiresAt: number } | null = null;

/** A token for the seller account's own API, cached until shortly before it expires. */
async function sellerAccountToken(credentials: { clientId: string; clientSecret: string }): Promise<string | null> {
  if (accountToken && accountToken.expiresAt - Date.now() > 120_000) return accountToken.value;
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
  const response = await fetchQatom(QATOM_ACCOUNT_TOKEN_URL, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, accept: "application/json" },
  });
  const parsed = z
    .object({ access_token: z.string().min(1), expires_at: z.coerce.number().optional() })
    .safeParse(response.ok ? await response.json().catch(() => null) : null);
  if (!parsed.success) return null;
  accountToken = {
    value: parsed.data.access_token,
    expiresAt: parsed.data.expires_at ? parsed.data.expires_at * 1000 : Date.now() + 10 * 60_000,
  };
  return accountToken.value;
}

/** Test hook: forget the cached seller-account token. */
export function resetQatomAccountToken(): void {
  accountToken = null;
}

type Confirmation = "confirmed" | "not_checked" | "refuted" | "unavailable";

/**
 * Ask Qatom whether a transaction is a settled, free sale of the expected
 * item. "not_checked" when no account credentials are configured.
 */
async function confirmWithQatom(transactionId: string, catalogItemId: number): Promise<Confirmation> {
  const credentials = qatomAccountCredentials();
  if (!credentials) return "not_checked";
  try {
    const token = await sellerAccountToken(credentials);
    if (!token) return "unavailable";
    const response = await fetchQatom(`${QATOM_PURCHASE_URL}/${transactionId}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (response.status === 404) return "refuted";
    if (!response.ok) return "unavailable";
    const parsed = z
      .object({ purchase: z.object({ transaction_id: z.string(), catalog_item_id: z.coerce.number(), amount: z.string() }) })
      .safeParse(await response.json().catch(() => null));
    if (!parsed.success) return "unavailable";
    const { purchase } = parsed.data;
    const matches =
      purchase.transaction_id.toLowerCase() === transactionId.toLowerCase() &&
      purchase.catalog_item_id === catalogItemId &&
      Number(purchase.amount) === 0;
    return matches ? "confirmed" : "refuted";
  } catch {
    return "unavailable";
  }
}

export async function handleQatomDispatch(input: {
  sellerSlug: string;
  authorization: string | null;
  transactionId: string | null;
  body: unknown;
}): Promise<DispatchOutcome> {
  // 1. The shared secret. Without it this address does not exist.
  const expected = qatomFulfilmentToken();
  if (!expected || !sameText(input.authorization ?? "", `Bearer ${expected}`)) return { kind: "not_found" };

  const catalogItemId = qatomItemFor(input.sellerSlug);
  const [seller] = await getDb()
    .select()
    .from(sellerProfiles)
    .where(and(eq(sellerProfiles.slug, input.sellerSlug), eq(sellerProfiles.status, "active")));
  if (catalogItemId === null || !seller?.isSample) return { kind: "not_found" };

  // 2. The Qatom transaction that carried it.
  const transactionId = input.transactionId?.trim().toLowerCase() ?? "";
  if (!UUID.test(transactionId)) return rejected("The delivery did not name a Qatom transaction.");
  const confirmation = await confirmWithQatom(transactionId, catalogItemId);
  if (confirmation === "refuted") return rejected("Qatom has no free sale of this item with that transaction id.");
  if (confirmation === "unavailable") {
    return rejected("The delivery could not be confirmed with Qatom just now. Send the message again.");
  }

  // 3. The message itself.
  const opened = openMessage(input.body);
  if (!opened.ok) return rejected(opened.reason);
  const { args, message } = opened;
  const answer = (reply: SellerReply): DispatchOutcome => ({
    kind: "answered",
    body: sealReply(args.engagement, args.nonce, reply),
  });

  // 4. Served once only. The unique keys make this hold under simultaneous deliveries too.
  const recorded = await getDb()
    .insert(qatomDispatches)
    .values({
      transactionId,
      sellerProfileId: seller.id,
      engagementId: args.engagement,
      action: args.action,
      nonce: args.nonce,
      confirmedWithQatom: confirmation === "confirmed",
    })
    .onConflictDoNothing()
    .returning({ id: qatomDispatches.id })
    .catch(() => []);
  if (recorded.length === 0) return rejected("This message has already been delivered, or its engagement is unknown.");

  // 5. The engagement must be active, with this seller.
  const gate = await checkAgentCommunication(args.engagement, seller.id);
  if (!gate.allowed) return answer({ kind: "refusal", reason: "This engagement does not permit messages to this seller." });

  return answer(await answerAsSampleSeller(args.engagement, message));
}
