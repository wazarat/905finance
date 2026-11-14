/**
 * The deciding part of a purchasing agent.
 *
 * A brain looks at where the engagement stands and proposes one next step as
 * a structured tool call. That is all it can do. It holds no credentials, has
 * no access to the database or the wallet, and cannot act: the runtime decides
 * whether a proposed call is even a tool that exists, and the policy engine
 * decides whether a purchase is allowed. A brain that is wrong, confused or
 * manipulated can only ever have its proposals refused.
 */

export type AgentService = {
  id: string;
  name: string;
  /** Listed price in the mandate asset's smallest unit, as a decimal string. */
  priceUnits: string;
  /** Purchases of this service already paid for in this engagement. */
  timesPurchased: number;
};

export type AgentContext = {
  sellerName: string;
  scope: string;
  asset: { code: string; decimals: number };
  services: AgentService[];
  budget: {
    totalUnits: string;
    perTransactionUnits: string;
    remainingUnits: string;
    walletAvailableUnits: string;
  };
  /** A service the buyer asked for instead of a declined proposal. Do it next. */
  directive: { offeringId: string } | null;
  /** True once the buyer has declined a request for more budget or funds. */
  limitsAreFinal: boolean;
  /** Purchases completed so far in this run. */
  purchasesThisRun: number;
  /** The most recent thing the seller said, verbatim. Untrusted. */
  lastSellerNote: string | null;
};

/** The tools an agent may call. There is no tool that changes a mandate, a seller, a rail or a wallet. */
export type AgentToolCall =
  | { tool: "purchase_service"; input: { offeringId: string; quantity?: number; reason: string } }
  | { tool: "finish"; input: { summary: string } };

export interface AgentBrain {
  readonly name: string;
  /** Propose the next step. Anything that is not a valid tool call is refused by the runtime. */
  next(context: AgentContext): Promise<unknown>;
}

/**
 * A deterministic agent with no language model. It works through the
 * permitted services in turn, most expensive first, buying whichever has been
 * bought least. When the buyer has declined more budget or funding, it buys
 * only what still fits and then stops.
 */
export class ScriptedBrain implements AgentBrain {
  readonly name = "scripted";

  async next(context: AgentContext): Promise<AgentToolCall> {
    if (context.directive) {
      const requested = context.services.find((s) => s.id === context.directive?.offeringId);
      if (requested) {
        return {
          tool: "purchase_service",
          input: { offeringId: requested.id, reason: `You asked for "${requested.name}" instead.` },
        };
      }
    }

    const perPurchase = BigInt(context.budget.perTransactionUnits);
    const remaining = BigInt(context.budget.remainingUnits);
    const available = BigInt(context.budget.walletAvailableUnits);
    const affordable = (s: AgentService) => BigInt(s.priceUnits) <= remaining && BigInt(s.priceUnits) <= available;

    const candidates = context.services
      .filter((s) => BigInt(s.priceUnits) <= perPurchase)
      .filter((s) => !context.limitsAreFinal || affordable(s))
      .sort((a, b) => {
        if (a.timesPurchased !== b.timesPurchased) return a.timesPurchased - b.timesPurchased;
        const byPrice = BigInt(b.priceUnits) - BigInt(a.priceUnits);
        return byPrice > 0n ? 1 : byPrice < 0n ? -1 : a.name.localeCompare(b.name);
      });

    const next = candidates[0];
    if (!next) {
      return {
        tool: "finish",
        input: {
          summary: context.limitsAreFinal
            ? "Nothing more fits within the budget and funds you approved."
            : "None of the permitted services fits within the per-purchase limit.",
        },
      };
    }
    return {
      tool: "purchase_service",
      input: {
        offeringId: next.id,
        reason:
          next.timesPurchased === 0
            ? `"${next.name}" is the next permitted service that has not been run yet.`
            : `"${next.name}" is next in rotation through the permitted services.`,
      },
    };
  }
}
