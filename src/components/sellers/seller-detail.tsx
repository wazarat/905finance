import type { ReactNode } from "react";
import {
  CapabilityChip,
  ListingStatusBadge,
  NotConnectedBadge,
  SampleBadge,
} from "@/components/sellers/badges";
import { ChainLink } from "@/components/goat/chain-link";
import { BILLING_UNIT_LABELS, NETWORK_ROLES, capabilityLabel } from "@/lib/capabilities";
import { agentExplorerLink } from "@/lib/goat";
import { formatMoney } from "@/lib/money";
import type { PublicSellerDetail } from "@/server/marketplace";

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

const PROTOCOL_LABELS = {
  https_json: "HTTPS / JSON",
  mcp: "MCP",
  a2a: "Agent-to-agent (A2A)",
} as const;

function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm text-foreground">{children}</dd>
    </div>
  );
}

/**
 * The buyer-facing view of a listing. Rendered on the public profile page and,
 * unchanged, in the seller's own preview. It only ever receives public fields.
 */
export function SellerDetail({
  seller,
  action,
  showStatus = false,
}: {
  seller: PublicSellerDetail;
  action?: ReactNode;
  showStatus?: boolean;
}) {
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-10">
        <header className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {seller.isSample ? <SampleBadge /> : null}
            {showStatus ? <ListingStatusBadge status={seller.status} /> : null}
          </div>
          <h1 className="text-3xl font-semibold text-balance text-foreground sm:text-4xl">
            {seller.displayName}
          </h1>
          {seller.tagline ? (
            <p className="max-w-2xl text-lg leading-relaxed text-ink-soft">{seller.tagline}</p>
          ) : null}
        </header>

        <section aria-labelledby="about-heading" className="space-y-3">
          <h2 id="about-heading" className="eyebrow">
            About this agent
          </h2>
          {seller.description ? (
            <div className="max-w-2xl space-y-4 text-[0.95rem] leading-relaxed text-ink-soft">
              {seller.description.split(/\n{2,}/).map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No description yet.</p>
          )}
        </section>

        <section aria-labelledby="capabilities-heading" className="space-y-3">
          <h2 id="capabilities-heading" className="eyebrow">
            Capabilities
          </h2>
          {seller.capabilities.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {seller.capabilities.map((capability) => (
                <CapabilityChip key={capability} capability={capability} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No capabilities listed yet.</p>
          )}
        </section>

        <section aria-labelledby="services-heading" className="space-y-3">
          <h2 id="services-heading" className="eyebrow">
            Services and pricing
          </h2>
          {seller.offerings.length > 0 ? (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {seller.offerings.map((offering) => (
                <li
                  key={offering.id}
                  className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium text-foreground">{offering.name}</p>
                    {offering.description ? (
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        {offering.description}
                      </p>
                    ) : null}
                    <p className="pt-1 text-xs text-muted-foreground">
                      {capabilityLabel(offering.capability)}
                      {offering.requiresWeb3 ? " · Web3 projects" : ""}
                    </p>
                  </div>
                  <div className="shrink-0 sm:text-right">
                    <p className="figure text-lg text-foreground">
                      {formatMoney(offering.priceMinor, offering.currency)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {BILLING_UNIT_LABELS[offering.billingUnit]}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No services published yet.</p>
          )}
          <p className="text-xs text-muted-foreground">
            Prices are per billing unit. Nothing is charged until you authorize an engagement and a
            budget.
          </p>
        </section>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
        {action}
        <div className="rounded-xl border border-border bg-card px-5 py-2">
          <dl className="divide-y divide-border">
            <FactRow label="Payment">
              <span className="flex flex-col items-end gap-1">
                <span>{NETWORK_ROLES.settlement.name}, in USD</span>
                <span className="text-xs text-muted-foreground">
                  {seller.settlesOnGoat
                    ? "Paid on GOAT Testnet3, in test assets"
                    : seller.identity?.confirmed
                      ? "Simulated: real settlement is not switched on"
                      : "Simulated: no confirmed GOAT identity to pay"}
                </span>
              </span>
            </FactRow>
            <FactRow label="Agent communication">
              <span className="flex flex-col items-end gap-1">
                <span>{NETWORK_ROLES.communication.name}</span>
                <span className="text-xs text-muted-foreground">
                  {seller.qatomCatalogItemId !== null
                    ? `Catalog item ${seller.qatomCatalogItemId}`
                    : "No catalog item yet"}
                </span>
              </span>
            </FactRow>
            <FactRow label="Agent endpoint">
              {seller.endpointProtocol ? (
                <span className="flex flex-col items-end gap-1">
                  <span>{PROTOCOL_LABELS[seller.endpointProtocol]}</span>
                  <span className="text-xs text-muted-foreground">Address shared after authorization</span>
                </span>
              ) : (
                <NotConnectedBadge label="Not linked" />
              )}
            </FactRow>
            <FactRow label="ERC-8004 identity">
              {seller.identity ? (
                <span className="flex flex-col items-end gap-1">
                  <a
                    href={agentExplorerLink(seller.identity.agentId)}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline decoration-border underline-offset-4 hover:decoration-foreground"
                  >
                    Agent {seller.identity.agentId}
                  </a>
                  <span className={seller.identity.confirmed ? "text-xs text-brand" : "text-xs text-warn"}>
                    {seller.identity.confirmed ? "Confirmed by its registration" : "Unconfirmed claim"}
                  </span>
                </span>
              ) : (
                <NotConnectedBadge label="Not linked" />
              )}
            </FactRow>
            {seller.identity ? (
              <>
                <FactRow label="Receiving wallet">
                  <span className="flex flex-col items-end gap-1">
                    <ChainLink value={seller.identity.agentWallet} short />
                    <span className="text-xs text-muted-foreground">
                      {seller.identity.confirmed
                        ? seller.identity.agentWalletSet
                          ? "Set in the registry"
                          : "The agent's owner; no wallet set"
                        : "Not used for payment"}
                    </span>
                  </span>
                </FactRow>
                <FactRow label="Registered owner">
                  <ChainLink value={seller.identity.ownerAddress} short />
                </FactRow>
              </>
            ) : null}
            <FactRow label="On-chain reputation">
              {seller.identity && !seller.identity.confirmed ? (
                // An unconfirmed claim must not borrow the standing of the agent it names.
                <span className="text-muted-foreground">Shown once the identity is confirmed</span>
              ) : seller.identity && seller.identity.reputation.count > 0 ? (
                <span className="flex flex-col items-end gap-1">
                  <span className="figure">{seller.identity.reputation.value}</span>
                  <span className="text-xs text-muted-foreground">
                    Registry summary of {seller.identity.reputation.count} feedback{" "}
                    {seller.identity.reputation.count === 1 ? "entry" : "entries"} from{" "}
                    {seller.identity.reputation.clients}{" "}
                    {seller.identity.reputation.clients === 1 ? "address" : "addresses"}
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">No feedback recorded</span>
              )}
            </FactRow>
          </dl>
        </div>
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">
          {seller.identity
            ? `Read from GOAT Testnet3 on ${dateFormat.format(seller.identity.refreshedAt)}. `
            : "Identity and reputation appear here once a seller links an ERC-8004 registration. "}
          A registration identifies an agent; it is not verification of a business. Reputation is
          shown as the registry reports it and is not checked or weighted by 905 Finance.
        </p>
      </aside>
    </div>
  );
}
