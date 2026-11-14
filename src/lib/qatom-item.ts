/**
 * The Qatom catalog item that carries messages to one seller's agent.
 *
 * Kept free of server code so that the endpoint which checks incoming
 * messages and the script which prints the listing both read the one
 * definition, and cannot drift apart.
 */

/** The item's input schema: the flat, named values a signed message is made of. */
export const CHANNEL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "engagement", "offering", "sent_at", "nonce", "signature"],
  properties: {
    action: {
      type: "string",
      enum: ["quote", "order"],
      description: "quote: ask the price of a test. order: ask for a test that has been paid for to be run.",
    },
    engagement: { type: "string", description: "The 905 Finance engagement the message belongs to, as a UUID." },
    offering: { type: "string", description: "The seller's service the message is about, as a UUID." },
    quantity: { type: "integer", minimum: 1, maximum: 100, description: "How many units. Defaults to 1." },
    purchase: { type: "string", description: "For an order: the purchase being fulfilled, as a UUID." },
    payment_reference: {
      type: "string",
      description: "For an order: the reference of the payment made on GOAT Network.",
    },
    sent_at: { type: "string", description: "When the message was sent, as an ISO 8601 time." },
    nonce: { type: "string", description: "A random value used once." },
    signature: { type: "string", description: "The sending agent's signature over every other value." },
  },
} as const;

/** Everything to enter when creating the item in the Qatom dashboard. */
export function qatomItemListing(seller: { slug: string; displayName: string }, baseUrl: string) {
  const origin = baseUrl.replace(/\/+$/, "");
  return {
    name: `905 Finance: ${seller.displayName} agent desk`,
    descriptor: `905 Finance ${seller.displayName}`.slice(0, 255),
    price: 0,
    method: "POST",
    endpoint: `${origin}/api/qatom/seller/${seller.slug}`,
    visibility: "Public",
    description:
      `Free. The message desk for ${seller.displayName}, a software-testing seller on 905 Finance. ` +
      "It answers signed requests from a 905 Finance purchasing agent acting under a buyer's authorized engagement: " +
      "action=quote returns the price of a test; action=order asks for a test already paid for to be run and returns a job id. " +
      "No payment is taken here: tests are paid for on GOAT Network. " +
      "Requests without a valid 905 Finance signature are declined, so this item is of no use to other agents.",
    header: { name: "Authorization", sensitivity: "Sensitive", value: "Bearer <your QATOM_FULFILMENT_TOKEN>" },
    serviceSchema: { inputSchema: CHANNEL_INPUT_SCHEMA },
  };
}
