import type { EngagementState } from "@/db/schema";

/**
 * The engagement state machine. Every state change in the system goes through
 * `canTransition`; nothing else decides what an engagement may do next.
 *
 *   DISCOVERING → SELLER_SELECTED → AUTHORIZED → WALLET_PROVISIONED
 *     → AWAITING_FUNDING → ACTIVE ⇄ PAUSED_FOR_APPROVAL → COMPLETED
 *
 * CANCELLED is reachable from any non-terminal state. EXPIRED and FAILED are
 * reachable once an engagement has been authorized. Terminal states are final.
 */

export const ENGAGEMENT_STATES = [
  "DISCOVERING",
  "SELLER_SELECTED",
  "AUTHORIZED",
  "WALLET_PROVISIONED",
  "AWAITING_FUNDING",
  "ACTIVE",
  "PAUSED_FOR_APPROVAL",
  "COMPLETED",
  "CANCELLED",
  "EXPIRED",
  "FAILED",
] as const satisfies readonly EngagementState[];

export const TERMINAL_STATES = ["COMPLETED", "CANCELLED", "EXPIRED", "FAILED"] as const;

const TRANSITIONS: Record<EngagementState, readonly EngagementState[]> = {
  DISCOVERING: ["SELLER_SELECTED", "CANCELLED"],
  SELLER_SELECTED: ["AUTHORIZED", "CANCELLED"],
  AUTHORIZED: ["WALLET_PROVISIONED", "CANCELLED", "EXPIRED", "FAILED"],
  WALLET_PROVISIONED: ["AWAITING_FUNDING", "CANCELLED", "EXPIRED", "FAILED"],
  AWAITING_FUNDING: ["ACTIVE", "CANCELLED", "EXPIRED", "FAILED"],
  ACTIVE: ["PAUSED_FOR_APPROVAL", "COMPLETED", "CANCELLED", "EXPIRED", "FAILED"],
  PAUSED_FOR_APPROVAL: ["ACTIVE", "COMPLETED", "CANCELLED", "EXPIRED", "FAILED"],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
  FAILED: [],
};

export function isTerminal(state: EngagementState): boolean {
  return (TERMINAL_STATES as readonly EngagementState[]).includes(state);
}

export function canTransition(from: EngagementState, to: EngagementState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: EngagementState): readonly EngagementState[] {
  return TRANSITIONS[from];
}

/** Only an ACTIVE engagement lets its purchasing agent talk to its seller. */
export function permitsAgentCommunication(state: EngagementState): boolean {
  return state === "ACTIVE";
}

/** Whether a human may still authorize funding into the engagement's wallet. */
export function permitsFunding(state: EngagementState): boolean {
  return state === "AWAITING_FUNDING" || state === "ACTIVE" || state === "PAUSED_FOR_APPROVAL";
}

/** States in which the engagement's deadline applies. */
export function isSubjectToExpiry(state: EngagementState): boolean {
  return canTransition(state, "EXPIRED");
}

export const ENGAGEMENT_STATE_LABELS: Record<EngagementState, string> = {
  DISCOVERING: "Choosing a seller",
  SELLER_SELECTED: "Seller selected",
  AUTHORIZED: "Authorized",
  WALLET_PROVISIONED: "Wallet provisioned",
  AWAITING_FUNDING: "Awaiting funding",
  ACTIVE: "Active",
  PAUSED_FOR_APPROVAL: "Paused for approval",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  FAILED: "Failed",
};

/** The steps a buyer walks through, for progress display. */
export const ENGAGEMENT_STEPS = [
  { key: "select", label: "Select seller", reachedAt: "SELLER_SELECTED" },
  { key: "authorize", label: "Authorize mandate", reachedAt: "AUTHORIZED" },
  { key: "provision", label: "Provision wallet", reachedAt: "AWAITING_FUNDING" },
  { key: "fund", label: "Authorize funding", reachedAt: "ACTIVE" },
] as const;

const PROGRESS_ORDER: EngagementState[] = [
  "DISCOVERING",
  "SELLER_SELECTED",
  "AUTHORIZED",
  "WALLET_PROVISIONED",
  "AWAITING_FUNDING",
  "ACTIVE",
];

/** How far along the setup path a state is. Later operating states count as fully set up. */
export function setupProgress(state: EngagementState): number {
  const index = PROGRESS_ORDER.indexOf(state);
  return index === -1 ? PROGRESS_ORDER.length - 1 : index;
}

export function stepIsComplete(state: EngagementState, reachedAt: EngagementState): boolean {
  return setupProgress(state) >= PROGRESS_ORDER.indexOf(reachedAt);
}
