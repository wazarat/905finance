import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { permitsAgentCommunication } from "@/lib/engagement-state";
import { isUuid } from "./authz";
import { forbidden } from "./errors";

const { engagements, purchasingAgents, engagementWallets, spendingMandates } = schema;

export type AgentGate = { allowed: true } | { allowed: false; reason: string };

const blocked = (reason: string): AgentGate => ({ allowed: false, reason });

/**
 * Whether an engagement's purchasing agent may exchange messages with a seller
 * right now. This is the single check every agent-to-seller interaction must
 * pass, and it is decided entirely from platform records:
 *
 *   - the engagement is ACTIVE and has not passed its deadline
 *   - the seller is the one the buyer selected for this engagement
 *   - the mandate is authorized, the agent is active and the wallet is active
 *
 * Nothing an agent or a seller says can change the outcome.
 */
export async function checkAgentCommunication(
  engagementId: string,
  sellerProfileId: string,
  now: Date = new Date(),
): Promise<AgentGate> {
  if (!isUuid(engagementId) || !isUuid(sellerProfileId)) return blocked("Unknown engagement.");
  const db = getDb();
  const [engagement] = await db.select().from(engagements).where(eq(engagements.id, engagementId));
  if (!engagement) return blocked("Unknown engagement.");

  if (!permitsAgentCommunication(engagement.state)) {
    return blocked(`The engagement is ${engagement.state}, not ACTIVE.`);
  }
  if (!engagement.expiresAt || engagement.expiresAt <= now) {
    return blocked("The engagement has passed its deadline.");
  }
  if (engagement.sellerProfileId !== sellerProfileId) {
    return blocked("This is not the seller selected for the engagement.");
  }

  const [mandate] = await db
    .select({ status: spendingMandates.status, sellerProfileId: spendingMandates.sellerProfileId })
    .from(spendingMandates)
    .where(eq(spendingMandates.engagementId, engagementId));
  if (!mandate || mandate.status !== "authorized" || mandate.sellerProfileId !== sellerProfileId) {
    return blocked("There is no authorized mandate for this seller.");
  }

  const [agent] = await db
    .select({ status: purchasingAgents.status })
    .from(purchasingAgents)
    .where(eq(purchasingAgents.engagementId, engagementId));
  if (!agent || agent.status !== "active") return blocked("The purchasing agent is not active.");

  const [wallet] = await db
    .select({ status: engagementWallets.status })
    .from(engagementWallets)
    .where(eq(engagementWallets.engagementId, engagementId));
  if (!wallet || wallet.status !== "active") return blocked("The engagement wallet is not active.");

  return { allowed: true };
}

/** Throws unless the agent may contact the seller. Call before any agent-to-seller message. */
export async function assertAgentMayContactSeller(
  engagementId: string,
  sellerProfileId: string,
  now: Date = new Date(),
): Promise<void> {
  const gate = await checkAgentCommunication(engagementId, sellerProfileId, now);
  if (!gate.allowed) throw forbidden(`Agent communication is blocked: ${gate.reason}`);
}
