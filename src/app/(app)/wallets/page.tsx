import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { EmptyState, PageHeader, Panel } from "@/components/app/page-header";
import { PageSkeleton } from "@/components/app/page-skeleton";
import {
  EngagementStateBadge,
  SimulatedBadge,
  WalletStatusBadge,
} from "@/components/engagements/badges";
import { ChainLink } from "@/components/goat/chain-link";
import { railLabel } from "@/lib/capabilities";
import { assetLabel, formatUnits } from "@/lib/units";
import { roleHasPermission } from "@/server/authz";
import { requireWorkspace } from "@/server/page-context";
import { getWalletOverview } from "@/server/wallets";
import { EnableRoleForm } from "../enable-role-form";
import { AddSimulatedFundsForm } from "./add-funds-form";

export const metadata: Metadata = { title: "Wallets" };

const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

const LEDGER_LABELS = {
  simulated_deposit: "Funds added to master account",
  funding_debit: "Allocated from master account to an engagement",
  funding_credit: "Received by engagement wallet",
  payment_debit: "Paid to seller from engagement wallet",
  return_debit: "Unused funds returned from an ended engagement",
  return_credit: "Unused funds received back in the master account",
} as const;

async function WalletsContent() {
  const { actor, workspace } = await requireWorkspace();

  if (!workspace.buyerProfile) {
    return (
      <div className="space-y-8">
        <PageHeader
          eyebrow="Buying"
          title="Wallets"
          description="Funding accounts belong to the buying side of your organization."
        />
        {workspace.role === "owner" ? (
          <EnableRoleForm role="buyer" label="Enable buying" />
        ) : (
          <p className="text-sm text-muted-foreground">Ask your organization&apos;s owner to enable buying.</p>
        )}
      </div>
    );
  }

  const overview = await getWalletOverview(actor, workspace.organization.id);
  const canManage = roleHasPermission(workspace.role, "wallet.manage");

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Buying"
        title="Wallets"
        description="One master account, and one dedicated wallet per engagement. Payments are made on GOAT Network; an agent can spend only what its own engagement's wallet holds."
      />

      <section aria-label="Master accounts" className="grid gap-4 lg:grid-cols-2">
        {overview.rails.map((rail) =>
          rail.fundingWallet ? (
            <div key={`funding-${rail.rail}`} className="rounded-xl border border-border bg-card p-5">
              <p className="eyebrow">Your funding wallet</p>
              <h2 className="mt-1 text-lg font-semibold text-foreground">GOAT Testnet3</h2>
              <dl className="mt-5 space-y-4">
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">Address</dt>
                  <dd className="mt-1 text-sm">
                    <ChainLink value={rail.fundingWallet} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">In engagement wallets</dt>
                  <dd className="figure mt-1 text-xl whitespace-nowrap text-foreground">
                    {formatUnits(rail.allocatedUnits, rail.asset)}
                  </dd>
                </div>
              </dl>
              <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
                This is your own wallet. 905 Finance holds no key to it and cannot move anything out
                of it: you fund an engagement by sending to that engagement&apos;s wallet yourself.
                Test assets only.
              </p>
            </div>
          ) : (
          <div key={rail.rail} className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="eyebrow">{rail.retired ? "Retired account" : "Master account"}</p>
                <h2 className="mt-1 text-lg font-semibold text-foreground">{railLabel(rail.rail)}</h2>
              </div>
              {rail.simulated ? <SimulatedBadge /> : null}
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-1 xl:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Unallocated</dt>
                <dd className="figure mt-1 text-xl whitespace-nowrap text-foreground">
                  {formatUnits(rail.unallocatedUnits, rail.asset)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">In engagement wallets</dt>
                <dd className="figure mt-1 text-xl whitespace-nowrap text-foreground">
                  {formatUnits(rail.allocatedUnits, rail.asset)}
                </dd>
              </div>
            </dl>
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              No agent can spend from this account. Funds leave it only when you authorize funding
              for a specific engagement.
            </p>
            {rail.retired ? (
              <p className="mt-4 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
                From an earlier setup. Nothing new is created on this account; it is shown
                for its history.
              </p>
            ) : rail.simulated ? (
              <div className="mt-5 border-t border-border pt-4">
                {canManage ? (
                  <AddSimulatedFundsForm rail={rail.rail} assetCode={assetLabel(rail.asset.code)} />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Only the organization&apos;s owner can add funds.
                  </p>
                )}
              </div>
            ) : null}
          </div>
          ),
        )}
      </section>

      <Panel
        title="Engagement wallets"
        description="Each belongs to exactly one engagement and cannot be reused or shared."
      >
        {overview.wallets.length === 0 ? (
          <EmptyState
            title="No engagement wallets yet"
            body="A wallet is provisioned when you authorize an engagement. It starts empty and is funded by a separate decision."
          />
        ) : (
          <ul className="-my-3 divide-y divide-border">
            {overview.wallets.map((wallet) => (
              <li key={wallet.id}>
                <Link
                  href={`/engagements/${wallet.engagementId}`}
                  className="grid gap-3 rounded-md py-4 outline-none hover:text-brand focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate font-medium text-foreground">{wallet.sellerName}</p>
                      <EngagementStateBadge state={wallet.engagementState} />
                    </div>
                    <p className="truncate text-sm text-muted-foreground">
                      {wallet.projectName} · {railLabel(wallet.rail)}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      <ChainLink value={wallet.providerRef} />
                    </p>
                  </div>
                  <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-1.5">
                    <p className="figure text-base text-foreground">
                      {formatUnits(wallet.balanceUnits, wallet.asset)}
                    </p>
                    <div className="flex items-center gap-2">
                      <WalletStatusBadge status={wallet.status} />
                      {wallet.isSimulated ? <SimulatedBadge /> : null}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Recent activity" description="The latest balance changes across your accounts.">
        {overview.ledger.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity yet.</p>
        ) : (
          <ul className="-my-3 divide-y divide-border">
            {overview.ledger.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-foreground">{LEDGER_LABELS[entry.kind]}</p>
                  <p className="text-xs text-muted-foreground">
                    {railLabel(entry.rail)} · {dateTimeFormat.format(entry.createdAt)}
                  </p>
                </div>
                <p
                  className={
                    entry.deltaUnits < 0n ? "figure text-sm text-ink-soft" : "figure text-sm text-brand"
                  }
                >
                  {entry.deltaUnits < 0n ? "−" : "+"}
                  {formatUnits(entry.deltaUnits < 0n ? -entry.deltaUnits : entry.deltaUnits, entry.asset)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

export default function WalletsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <WalletsContent />
    </Suspense>
  );
}
