import "server-only";
import { GOAT_TESTNET3 } from "@/lib/goat";
import { requirePermission, type Actor } from "./authz";
import { isDevAuthEnabled, privyServerConfig, sessionSecretOrNull, workerToken } from "./env";
import { goatLiveConfig, goatLiveGaps } from "./goat/live";
import { qatomAccountCredentials, qatomFulfilmentToken, qatomSellerItems } from "./qatom/config";
import { getQatomStatus } from "./qatom/connection";
import { getWorkerStatus } from "./testing/jobs";

export type IntegrationState = "live" | "partial" | "simulated" | "off";

export type IntegrationLine = {
  name: string;
  /** What it is for, in a few words. */
  role: string;
  state: IntegrationState;
  /** What is true right now. */
  summary: string;
  /** What is still missing, shown to owners only. Setting names, never values. */
  missing: string[];
};

/**
 * What each outside system this application depends on is actually doing in
 * this deployment: really connected, partly connected, simulated, or off.
 * It reports setting names that are missing, and never a setting's value.
 */
export async function getIntegrationStatus(actor: Actor | null, organizationId: string): Promise<IntegrationLine[]> {
  const membership = await requirePermission(actor, organizationId, "qatom.view");
  const isOwner = membership.role === "owner";
  const forOwner = (missing: string[]) => (isOwner ? missing : []);

  const privy = privyServerConfig();
  const worker = await getWorkerStatus();
  const workerConfigured = workerToken() !== null;
  const qatom = await getQatomStatus(actor, organizationId).catch(() => null);
  const qatomItems = qatomSellerItems().size;
  const qatomSecret = qatomFulfilmentToken() !== null;
  const goat = goatLiveConfig();

  return [
    {
      name: "Sign-in",
      role: "Who you are",
      state: privy && sessionSecretOrNull() ? "live" : isDevAuthEnabled() ? "simulated" : "off",
      summary: privy
        ? "Privy verifies every sign-in."
        : isDevAuthEnabled()
          ? "Development sign-in only. Not available in production."
          : "Nobody can sign in.",
      missing: forOwner(privy ? [] : ["NEXT_PUBLIC_PRIVY_APP_ID", "PRIVY_APP_SECRET"]),
    },
    {
      name: "Testing worker",
      role: "Runs the tests",
      state: worker.online ? "live" : "off",
      summary: worker.online
        ? `Online, with ${Object.keys(worker.tools).join(", ") || "no tools"}. Tests are executed for real.`
        : workerConfigured
          ? "No worker is online. Sellers decline to quote, so no test can be bought."
          : "Not set up. Sellers decline to quote, so no test can be bought.",
      missing: forOwner([
        ...(workerConfigured ? [] : ["WORKER_TOKEN"]),
        ...(worker.online ? [] : ["a running testing worker pointed at this site"]),
      ]),
    },
    {
      name: "Qatom",
      role: "Carries agent messages",
      state: qatom?.connected && qatomItems > 0 && qatomSecret ? "live" : qatomItems > 0 || qatomSecret || qatom?.connected ? "partial" : "simulated",
      summary:
        qatom?.connected && qatomItems > 0 && qatomSecret
          ? `Messages to ${qatomItems} ${qatomItems === 1 ? "seller go" : "sellers go"} through Qatom.${qatomAccountCredentials() ? " Every delivery is confirmed with Qatom." : ""}`
          : "Agents use the built-in channel.",
      missing: forOwner([
        ...(qatomSecret ? [] : ["QATOM_FULFILMENT_TOKEN"]),
        ...(qatomItems > 0 ? [] : ["QATOM_SELLER_ITEMS (a catalog item per seller)"]),
        ...(qatom?.connected ? [] : ["your Qatom account linked, below"]),
      ]),
    },
    {
      name: "GOAT identity",
      role: "Who a seller is",
      state: "live",
      summary: `Seller identity and reputation are read from ${GOAT_TESTNET3.name}.`,
      missing: [],
    },
    {
      name: "GOAT payments",
      role: "Wallets and payment",
      state: goat ? "live" : "simulated",
      summary: goat
        ? `Real wallets and payments on ${GOAT_TESTNET3.name}, in ${goat.token.symbol}, for sellers with a confirmed identity. Test assets only.`
        : "No wallet or payment touches a chain.",
      missing: forOwner(goat ? [] : goatLiveGaps()),
    },
  ];
}
