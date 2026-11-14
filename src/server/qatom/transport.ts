import "server-only";
import type { AgentToSeller, SellerReply, SellerTransport } from "../agent/transport";
import { qatomAccessToken } from "./connection";
import { CHANNEL_PROTOCOL, openReply, sealMessage } from "./envelope";
import { QatomUnauthorized, callQatomTool, objectsWithin, type ToolResult } from "./mcp";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const refuse = (reason: string): SellerReply => ({ kind: "refusal", reason });

/** Qatom's own id for the sale that carried a message, wherever in the receipt it appears. */
function transactionIdIn(objects: Record<string, unknown>[]): string | null {
  for (const object of objects) {
    for (const [key, value] of Object.entries(object)) {
      if (/transaction[_-]?id/i.test(key) && typeof value === "string" && UUID.test(value)) return value;
    }
  }
  return null;
}

/**
 * Carries an engagement's messages to its seller through Qatom.
 *
 * Each message is sent by checking out the seller's catalog item, which is
 * free: Qatom delivers the message to the seller's endpoint and hands the
 * seller's answer back in the same call. No money moves through Qatom.
 * Payment is made separately, on GOAT, by the policy engine.
 *
 * What comes back is checked before it is believed: it must be signed by the
 * seller's side of this engagement and answer the exact message that was
 * sent. Anything else is treated as the seller not having answered.
 */
export class QatomSellerTransport implements SellerTransport {
  readonly channel = "qatom" as const;
  readonly simulated = false;
  readonly description: string;
  private reference: string | null = null;

  constructor(
    private readonly context: { engagementId: string; organizationId: string; catalogItemId: number },
  ) {
    this.description = `Qatom, catalog item ${context.catalogItemId}. Messages are signed, and the seller's replies are verified. No money moves through Qatom.`;
  }

  /** Qatom's transaction id for the message just sent, once. */
  takeReference(): string | null {
    const reference = this.reference;
    this.reference = null;
    return reference;
  }

  async send(message: AgentToSeller): Promise<SellerReply> {
    this.reference = null;
    const args = sealMessage(this.context.engagementId, message);
    if (!args) return refuse("That question is not carried over Qatom.");

    let result: ToolResult;
    try {
      result = await this.checkout(args, false);
    } catch (error) {
      if (!(error instanceof QatomUnauthorized)) {
        console.error("Qatom checkout failed", error);
        return refuse("Qatom could not be reached, so the message was not delivered.");
      }
      // The token was refused: renew it once and try again. A message is only
      // acted on once however many times it is delivered.
      try {
        result = await this.checkout(args, true);
      } catch {
        return refuse("The Qatom sign-in is no longer valid. Reconnect Qatom in Settings.");
      }
    }

    const objects = objectsWithin(result.content);
    this.reference = transactionIdIn(objects);

    // Qatom stops for the owner's approval on anything priced above their
    // auto-approve limit, and can do so even for a free item. An agent here
    // cannot approve anything at Qatom, and must not: no payment is ever made
    // through it. The message was not delivered, and nothing is bought.
    if (objects.some((object) => "approval_id" in object || "approval_url" in object)) {
      return refuse(
        "Qatom asked for the owner's approval before delivering this message, which an agent cannot give. Nothing was sent or paid. If the seller's item is free, set an auto-approve limit in Qatom; if it has a price, it should not.",
      );
    }

    for (const object of objects) {
      if (object.protocol !== CHANNEL_PROTOCOL) continue;
      const reply = openReply(this.context.engagementId, args.nonce, object);
      // Still the seller's words: the runtime validates the shape before using any of it.
      if (reply) return reply as SellerReply;
      return refuse("The seller's reply could not be verified, so it was not used.");
    }
    return refuse(
      result.isError
        ? "Qatom reported an error delivering the message."
        : "No reply from the seller came back through Qatom.",
    );
  }

  private async checkout(args: Record<string, unknown>, forceRefresh: boolean): Promise<ToolResult> {
    const token = await qatomAccessToken(this.context.organizationId, { forceRefresh });
    if (!token) throw new QatomUnauthorized();
    return callQatomTool(token, "agent_checkout", {
      catalog_item_id: this.context.catalogItemId,
      arguments: args,
    });
  }
}
