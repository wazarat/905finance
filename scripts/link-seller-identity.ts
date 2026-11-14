import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

/**
 * Platform operation: link a sample seller's listing to its ERC-8004 agent
 * on GOAT Testnet3.
 *
 *   pnpm seller:identity <slug> <agent-id>
 *
 * The sample sellers have no owner who can sign in, so an operator does
 * this for them. It only reads the chain. The owner, the receiving wallet
 * and whether the link is confirmed are whatever the registry and the
 * agent's registration document say: an operator cannot confirm a link the
 * registration does not.
 */
async function main() {
  const [slug, agentId] = process.argv.slice(2);
  if (!slug || !agentId) {
    console.error("Usage: pnpm seller:identity <slug> <agent-id>");
    process.exit(1);
  }
  const { linkSellerIdentityAsOperator } = await import("../src/server/identity");
  const saved = await linkSellerIdentityAsOperator(slug, agentId);
  console.log(`Linked ${slug} to agent ${saved.agentId}.`);
  console.log(`  Owner             ${saved.ownerAddress}`);
  console.log(`  Receiving wallet  ${saved.agentWallet}${saved.agentWalletSet ? "" : " (the owner; none set)"}`);
  console.log(`  Registration      ${saved.agentUri || "none"}`);
  if (saved.registrationProblem) console.log(`  Problem           ${saved.registrationProblem}`);
  console.log(
    saved.confirmed
      ? "  Confirmed: the registration names this listing."
      : "  Unconfirmed: the registration does not name this listing, so its wallet is not used for payment.",
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
