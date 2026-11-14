import "server-only";
import { z } from "zod";
import { CHANNEL_INPUT_SCHEMA } from "@/lib/qatom-item";
import type { AgentToSeller, SellerReply } from "../agent/transport";
import { randomToken, signForEngagement, signatureMatches } from "./crypto";

/**
 * The form a message takes while Qatom carries it.
 *
 * Qatom forwards a catalog item's declared arguments to the seller as a flat
 * set of named values, and says nothing about who the buyer is. So a message
 * is flattened into simple named values, and signed: the signature covers
 * every value, the engagement it belongs to, when it was sent and a random
 * number used once. A seller can then tell that a message really comes from
 * the engagement it names, has not been altered on the way, is recent, and
 * has not been delivered before.
 *
 * The reply is signed the same way and tied to the message it answers, so a
 * reply cannot be forged, altered, or swapped for the answer to another
 * question.
 */

export const CHANNEL_PROTOCOL = "905finance-agent-channel/1";
/** How far a message's clock may differ from the receiver's. */
export const MAX_MESSAGE_AGE_MS = 5 * 60_000;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/** The arguments of the catalog item, exactly as declared in its input schema. */
export const channelArguments = z
  .object({
    action: z.enum(["quote", "order"]),
    engagement: uuid,
    offering: uuid,
    quantity: z.coerce.number().int().min(1).max(100).default(1),
    purchase: z.union([uuid, z.literal("")]).default(""),
    payment_reference: z.string().max(300).default(""),
    sent_at: z.string().max(40),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
    signature: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type ChannelArguments = z.infer<typeof channelArguments>;

export { CHANNEL_INPUT_SCHEMA };

/** The exact text a message's signature covers. Order and separators are fixed. */
function messageText(args: Omit<ChannelArguments, "signature">): string {
  return [
    CHANNEL_PROTOCOL,
    "message",
    args.action,
    args.engagement,
    args.offering,
    String(args.quantity),
    args.purchase,
    args.payment_reference,
    args.sent_at,
    args.nonce,
  ].join("\n");
}

function replyText(engagementId: string, nonce: string, reply: SellerReply): string {
  return [CHANNEL_PROTOCOL, "reply", engagementId, nonce, canonical(reply)].join("\n");
}

/** JSON with keys in a fixed order, so both ends sign the same bytes. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** Turn an agent's message into signed item arguments. Null for a kind Qatom does not carry. */
export function sealMessage(
  engagementId: string,
  message: AgentToSeller,
  now: Date = new Date(),
): ChannelArguments | null {
  if (message.kind === "status_request") return null;
  const unsigned = {
    action: message.kind === "quote_request" ? ("quote" as const) : ("order" as const),
    engagement: engagementId,
    offering: message.offeringId,
    quantity: message.kind === "quote_request" ? message.quantity : 1,
    purchase: message.kind === "delivery_request" ? message.purchaseId : "",
    payment_reference: message.kind === "delivery_request" ? message.paymentReference : "",
    sent_at: now.toISOString(),
    nonce: randomToken(18),
  };
  return { ...unsigned, signature: signForEngagement(engagementId, messageText(unsigned)) };
}

export type OpenedMessage =
  | { ok: true; args: ChannelArguments; message: AgentToSeller }
  | { ok: false; reason: string };

/** Check what arrived at the seller: well formed, signed by the engagement it names, and recent. */
export function openMessage(raw: unknown, now: Date = new Date()): OpenedMessage {
  const parsed = channelArguments.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "The message was not in the expected form." };
  const { signature, ...unsigned } = parsed.data;
  if (!signatureMatches(unsigned.engagement, messageText(unsigned), signature)) {
    return { ok: false, reason: "The message's signature is not valid." };
  }
  const sentAt = Date.parse(unsigned.sent_at);
  if (!Number.isFinite(sentAt) || Math.abs(now.getTime() - sentAt) > MAX_MESSAGE_AGE_MS) {
    return { ok: false, reason: "The message is too old to act on." };
  }
  const args = parsed.data;
  if (args.action === "quote") {
    return {
      ok: true,
      args,
      message: { kind: "quote_request", offeringId: args.offering, quantity: args.quantity },
    };
  }
  if (!args.purchase) return { ok: false, reason: "An order must name its purchase." };
  return {
    ok: true,
    args,
    message: {
      kind: "delivery_request",
      offeringId: args.offering,
      purchaseId: args.purchase,
      paymentReference: args.payment_reference,
    },
  };
}

/** What the seller endpoint sends back through Qatom. */
export type ChannelResponse = {
  ok: boolean;
  protocol: typeof CHANNEL_PROTOCOL;
  engagement: string;
  nonce: string;
  as_of: string;
  summary: string;
  result: SellerReply;
  signature: string;
};

export function sealReply(engagementId: string, nonce: string, reply: SellerReply): ChannelResponse {
  return {
    ok: reply.kind !== "refusal",
    protocol: CHANNEL_PROTOCOL,
    engagement: engagementId,
    nonce,
    as_of: new Date().toISOString(),
    summary:
      reply.kind === "refusal"
        ? `Declined: ${reply.reason}`
        : reply.kind === "quote"
          ? "Quoted. Payment is made on GOAT Network, not through Qatom."
          : reply.kind === "accepted"
            ? "Order accepted and queued for the testing worker."
            : "Answered.",
    result: reply,
    signature: signForEngagement(engagementId, replyText(engagementId, nonce, reply)),
  };
}

const channelResponse = z.object({
  protocol: z.literal(CHANNEL_PROTOCOL),
  engagement: z.string(),
  nonce: z.string(),
  result: z.record(z.string(), z.unknown()),
  signature: z.string(),
});

/**
 * Check a reply that came back through Qatom: that it is this channel's,
 * answers the message that was sent, and was signed by the seller's side of
 * the same engagement. Returns the seller's reply, still to be treated as
 * untrusted data by whoever reads it.
 */
export function openReply(engagementId: string, nonce: string, raw: unknown): unknown | null {
  const parsed = channelResponse.safeParse(raw);
  if (!parsed.success) return null;
  const { engagement, nonce: echoed, result, signature } = parsed.data;
  if (engagement !== engagementId || echoed !== nonce) return null;
  if (!signatureMatches(engagementId, replyText(engagementId, nonce, result as SellerReply), signature)) {
    return null;
  }
  return result;
}
