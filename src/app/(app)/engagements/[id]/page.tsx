import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Ban, Check } from "lucide-react";
import { PageHeader, Panel } from "@/components/app/page-header";
import { PageSkeleton } from "@/components/app/page-skeleton";
import {
  EngagementStateBadge,
  EngagementStepper,
  SimulatedBadge,
  WalletStatusBadge,
} from "@/components/engagements/badges";
import { ChainLink } from "@/components/goat/chain-link";
import { Button } from "@/components/ui/button";
import {
  BILLING_UNIT_LABELS,
  capabilityLabel,
  NETWORK_ROLES,
  SETTLEMENT_RAIL,
  getRail,
  railLabel,
} from "@/lib/capabilities";
import {
  ENGAGEMENT_STATE_LABELS,
  isTerminal,
  permitsAgentCommunication,
  permitsFunding,
} from "@/lib/engagement-state";
import { formatMoney } from "@/lib/money";
import { assetLabel, formatUnits, unitsToDecimalString } from "@/lib/units";
import { getEngagementActivity } from "@/server/engagement-activity";
import {
  getEngagementDetail,
  getWalletChainState,
  type EngagementDetail,
  type WalletChainState,
} from "@/server/engagements";
import { getEngagementStatement } from "@/server/closure";
import { isAppError } from "@/server/errors";
import { requireWorkspace } from "@/server/page-context";
import {
  AgentPanel,
  ApprovalPanel,
  BudgetPanel,
  ConversationPanel,
  PurchasesPanel,
} from "./agent-panels";
import {
  AuthorizeEngagementForm,
  CancelEngagementForm,
  ChainFundingForm,
  CheckReturnForm,
  CompleteEngagementForm,
  ReturnFundsForm,
  FundingForm,
  MandateForm,
  ProvisionWalletForm,
} from "./engagement-forms";

export const metadata: Metadata = { title: "Engagement" };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });
const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

/** The two networks every engagement uses, and the one job each does. */
function NetworkRoles() {
  return (
    <dl className="mb-8 grid gap-3 sm:grid-cols-2">
      {[NETWORK_ROLES.communication, NETWORK_ROLES.settlement].map((network) => (
        <div key={network.name} className="rounded-lg border border-border bg-background/40 p-4">
          <dt className="eyebrow">{network.role}</dt>
          <dd className="mt-1.5">
            <span className="font-medium text-foreground">{network.name}</span>
            <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
              {network.detail}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

const RETURN_LABELS: Record<string, string> = {
  authorized: "Authorized",
  sent: "Sent · awaiting confirmation",
  executed: "Returned",
  failed: "Not returned",
  uncertain: "Outcome unknown · not re-sent",
};

/** Marks a wallet or payment that is on GOAT Testnet3 rather than simulated. */
function NetworkBadge() {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-info/30 bg-info-dim px-2.5 py-0.5 text-xs font-medium whitespace-nowrap text-info"
      title="A real wallet on GOAT Testnet3. Test assets only: nothing here has monetary value."
    >
      GOAT Testnet3
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words text-foreground">{children}</dd>
    </div>
  );
}

function OwnerOnly({ what }: { what: string }) {
  return <p className="text-sm text-muted-foreground">Only the organization&apos;s owner can {what}.</p>;
}

/** Whether the purchasing agent may talk to the seller, stated plainly. */
function AgentAccess({ detail }: { detail: EngagementDetail }) {
  const { engagement, seller } = detail;
  const open = permitsAgentCommunication(engagement.state) && detail.agent?.status === "active";
  return (
    <div
      className={
        open
          ? "rounded-xl border border-brand/30 bg-brand-dim p-5"
          : "rounded-xl border border-border bg-card p-5"
      }
    >
      <div className="flex items-start gap-3">
        {open ? (
          <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
        ) : (
          <Ban className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            {open
              ? `The purchasing agent may contact ${seller.displayName}`
              : "Agent communication is blocked"}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {open
              ? "It may contact this seller only, and only while the engagement is active. Every purchase it attempts is checked against your mandate first."
              : engagement.state === "PAUSED_FOR_APPROVAL"
                ? "The engagement is paused for your decision. No paid work can start while it is paused."
                : isTerminal(engagement.state)
                ? "This engagement has ended. The agent's authority is revoked."
                : "No agent may contact the seller until the engagement is authorized, its wallet is provisioned and funded, and every check has passed."}
          </p>
        </div>
      </div>
    </div>
  );
}

function MandateSummary({ detail }: { detail: EngagementDetail }) {
  const mandate = detail.mandate;
  if (!mandate) return null;
  const permitted = detail.seller.offerings.filter((o) => mandate.permittedOfferingIds.includes(o.id));
  return (
    <dl className="-my-3 divide-y divide-border">
      <Row label="Total budget">
        <span className="figure">{formatUnits(mandate.totalAuthorizedUnits, mandate.asset)}</span>
      </Row>
      <Row label="Per-purchase limit">
        <span className="figure">{formatUnits(mandate.perTransactionLimitUnits, mandate.asset)}</span>
      </Row>
      <Row label="Payment">
        {detail.engagement.rail ? railLabel(detail.engagement.rail) : "—"} · {assetLabel(mandate.asset.code)}
      </Row>
      <Row label="Approved seller">{detail.seller.displayName}</Row>
      <Row label="Receiving account">
        {mandate.authorizedRecipient ?? (
          <span className="text-muted-foreground">
            Not connected. Set when the seller links a real receiving account.
          </span>
        )}
      </Row>
      <Row label="Permitted services">
        <ul className="space-y-1">
          {permitted.map((offering) => (
            <li key={offering.id} className="flex flex-wrap items-baseline justify-between gap-x-4">
              <span>
                {offering.name}
                {offering.isActive ? "" : " (no longer offered)"}
              </span>
              <span className="figure text-xs text-muted-foreground">
                {formatMoney(offering.priceMinor, offering.currency)}{" "}
                {BILLING_UNIT_LABELS[offering.billingUnit]}
              </span>
            </li>
          ))}
        </ul>
      </Row>
      <Row label="Testing scope">
        <span className="whitespace-pre-line">{mandate.scope}</span>
      </Row>
      <Row label="Expires">{dateTimeFormat.format(mandate.expiresAt)}</Row>
      <Row label="Needs your approval">
        Any budget increase, any additional funding, any change of scope
      </Row>
      {mandate.authorizedAt ? (
        <Row label="Authorized">{dateTimeFormat.format(mandate.authorizedAt)}</Row>
      ) : null}
    </dl>
  );
}

function WalletSummary({ detail, chain }: { detail: EngagementDetail; chain: WalletChainState | null }) {
  const wallet = detail.wallet;
  if (!wallet) return null;
  const gas = chain ? formatUnits(chain.gasUnits, { code: chain.gasSymbol, decimals: chain.gasDecimals }) : null;
  return (
    <dl className="-my-3 divide-y divide-border">
      <Row label={wallet.isSimulated ? "Balance" : "Funded and unspent"}>
        <span className="figure text-base">{formatUnits(wallet.balanceUnits, wallet.asset)}</span>
        {wallet.isSimulated ? null : (
          <span className="mt-0.5 block text-xs text-muted-foreground">
            What the platform has confirmed in and paid out. This, not the chain balance, is what the
            agent may spend.
          </span>
        )}
      </Row>
      {wallet.isSimulated ? null : (
        <>
          <Row label="On the chain now">
            {chain ? (
              <>
                <span className="figure">{formatUnits(chain.tokenUnits, wallet.asset)}</span>
                {chain.tokenUnits !== wallet.balanceUnits ? (
                  <span className="mt-0.5 block text-xs text-warn">
                    Differs from the confirmed figure above. Tokens sent without a funding
                    authorization are not spendable until one is recorded.
                  </span>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground">GOAT Testnet3 could not be read just now.</span>
            )}
          </Row>
          <Row label="For network fees">
            {chain ? (
              <>
                <span className="figure">{gas}</span>
                {chain.gasUnits === 0n ? (
                  <span className="mt-0.5 block text-xs text-warn">
                    This wallet pays its own network fees and has nothing to pay them with. Send it
                    a little test {chain.gasSymbol} before the agent runs, or payments will not go out.
                  </span>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground">Unknown</span>
            )}
          </Row>
        </>
      )}
      <Row label="Status">
        <WalletStatusBadge status={wallet.status} />
      </Row>
      <Row label="Belongs to">This engagement only. It cannot be used by any other.</Row>
      <Row label={wallet.isSimulated ? "Reference" : "Address"}>
        <ChainLink value={wallet.providerRef} className="text-xs text-ink-soft" />
      </Row>
    </dl>
  );
}

async function EngagementContent({ params }: PageProps<"/engagements/[id]">) {
  const { id } = await params;
  const { actor } = await requireWorkspace();
  const detail = await getEngagementDetail(actor, id).catch((error: unknown) => {
    // An engagement in another organization is indistinguishable from a missing one.
    if (isAppError(error) && (error.code === "not_found" || error.code === "forbidden")) notFound();
    throw error;
  });

  const activity = await getEngagementActivity(actor, id);
  const { engagement, seller, project, mandate, wallet, can } = detail;
  const chain = wallet && !wallet.isSimulated ? await getWalletChainState(actor, id) : null;
  const statement = wallet ? await getEngagementStatement(actor, id) : null;
  const state = engagement.state;
  const ended = isTerminal(state);

  // --- draft mandate form inputs -------------------------------------------
  // Payment is always on the settlement network; its asset is what the mandate is denominated in.
  const settlementAsset = assetLabel(mandate?.asset.code ?? getRail(SETTLEMENT_RAIL)!.simulatedAsset.code);
  const activeOfferings = seller.offerings.filter((o) => o.isActive);
  const offeringOptions = activeOfferings.map((o) => ({
    id: o.id,
    name: o.name,
    priceLabel: `${formatMoney(o.priceMinor, o.currency)} ${BILLING_UNIT_LABELS[o.billingUnit]}`,
    detail: o.description || capabilityLabel(o.capability),
  }));
  const draftValues = {
    totalBudget: mandate
      ? unitsToDecimalString(mandate.totalAuthorizedUnits, mandate.asset.decimals)
      : "100.00",
    perTransactionLimit: mandate
      ? unitsToDecimalString(mandate.perTransactionLimitUnits, mandate.asset.decimals)
      : "25.00",
    offeringIds: mandate
      ? mandate.permittedOfferingIds.filter((oid) => activeOfferings.some((o) => o.id === oid))
      : activeOfferings.map((o) => o.id),
    scope: mandate?.scope ?? "",
    expiresInDays: String(mandate?.daysUntilExpiry ?? 30),
  };

  // --- funding form inputs --------------------------------------------------
  const master = detail.masterBalanceUnits ?? 0n;
  const fundingRequest =
    activity.pendingApproval?.kind === "additional_funding" ? activity.pendingApproval : null;
  const suggested = fundingRequest
    ? // The agent is waiting on a specific shortfall: suggest exactly that.
      unitsToDecimalString(fundingRequest.shortfallUnits, fundingRequest.asset.decimals)
    : wallet && mandate
      ? wallet.balanceUnits > 0n
        ? ""
        : unitsToDecimalString(
            mandate.totalAuthorizedUnits < master ? mandate.totalAuthorizedUnits : master,
            wallet.asset.decimals,
          )
      : "";

  return (
    <div className="space-y-8">
      <Link
        href="/engagements"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Engagements
      </Link>

      <PageHeader
        eyebrow="Engagement"
        title={seller.displayName}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <EngagementStateBadge state={state} />
                <span>
              Project:{" "}
              <Link href={`/projects/${project.id}`} className="text-ink-soft underline underline-offset-4">
                {project.name}
              </Link>
            </span>
          </span>
        }
        actions={
          <Button asChild variant="outline" size="lg" className="h-10 px-4">
            <Link href={`/agents/${seller.slug}`}>View seller</Link>
          </Button>
        }
      />

      {ended ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-sm font-medium text-foreground">
            This engagement is {ENGAGEMENT_STATE_LABELS[state].toLowerCase()}.
          </p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Nothing further can be purchased under it.
            {wallet && wallet.balanceUnits > 0n
              ? ` ${formatUnits(wallet.balanceUnits, wallet.asset)} remains in its wallet. It stays there until you authorize its return, in the final financial record below.`
              : ""}
          </p>
        </div>
      ) : (
        <EngagementStepper state={state} />
      )}

      <AgentAccess detail={detail} />


      {activity.pendingApproval ? (
        <ApprovalPanel approval={activity.pendingApproval} activity={activity} />
      ) : null}

      {activity.budget && wallet && state !== "SELLER_SELECTED" ? (
        <BudgetPanel budget={activity.budget} />
      ) : null}

      {wallet && (state === "ACTIVE" || state === "PAUSED_FOR_APPROVAL" || activity.lastRun) ? (
        <AgentPanel
          engagementId={engagement.id}
          state={state}
          sellerName={seller.displayName}
          activity={activity}
        />
      ) : null}

      {activity.purchases.length > 0 || state === "ACTIVE" ? <PurchasesPanel activity={activity} /> : null}

      <ConversationPanel messages={activity.messages} sellerName={seller.displayName} />

      {/* 1. Seller selected: configure and authorize the mandate */}
      {state === "SELLER_SELECTED" ? (
        <>
          <Panel
            title="Spending mandate"
            description="Set what the agent may spend, on what, and until when. Saving is not authorizing."
          >
            <NetworkRoles />
            {can.draft ? (
              <MandateForm
                engagementId={engagement.id}
                assetCode={settlementAsset}
                offerings={offeringOptions}
                initial={draftValues}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Owners and admins can set up the mandate.
              </p>
            )}
          </Panel>

          <Panel
            title="Authorize engagement"
            description="Your explicit go-ahead. Until you give it, no agent exists and the seller is not contacted."
          >
            {!mandate ? (
              <p className="text-sm text-muted-foreground">Save the mandate above first.</p>
            ) : !seller.isActive ? (
              <p className="text-sm text-destructive">
                This seller&apos;s listing is no longer active, so the engagement can&apos;t be
                authorized.
              </p>
            ) : can.authorize ? (
              <AuthorizeEngagementForm
                engagementId={engagement.id}
                sellerName={seller.displayName}
                totalLabel={formatUnits(mandate.totalAuthorizedUnits, mandate.asset)}
                perPurchaseLabel={formatUnits(mandate.perTransactionLimitUnits, mandate.asset)}
                expiresLabel={dateFormat.format(mandate.expiresAt)}
              />
            ) : (
              <OwnerOnly what="authorize an engagement" />
            )}
          </Panel>
        </>
      ) : null}

      {/* From authorization on: the locked mandate */}
      {mandate && state !== "SELLER_SELECTED" ? (
        <Panel
          title="Spending mandate"
          description={
            mandate.status === "authorized"
              ? "Authorized by you. A budget is permission to spend, not money: it holds no funds."
              : mandate.status === "revoked"
                ? "Revoked when the engagement ended."
                : "Draft."
          }
        >
          <MandateSummary detail={detail} />
        </Panel>
      ) : null}

      {/* 2. Authorized but no wallet yet */}
      {state === "AUTHORIZED" ? (
        <Panel
          title="Engagement wallet"
          description="Each engagement gets its own wallet. Provisioning creates it empty."
        >
          {can.authorize ? (
            <ProvisionWalletForm engagementId={engagement.id} />
          ) : (
            <OwnerOnly what="provision the wallet" />
          )}
        </Panel>
      ) : null}

      {/* 3. Wallet exists */}
      {wallet ? (
        <Panel
          title="Engagement wallet"
          description="Dedicated to this engagement. Separate from your master account and from every other engagement."
          action={wallet.isSimulated ? <SimulatedBadge /> : <NetworkBadge />}
        >
          <WalletSummary detail={detail} chain={chain} />
        </Panel>
      ) : null}

      {wallet && permitsFunding(state) ? (
        <Panel
          title={state === "AWAITING_FUNDING" ? "Authorize funding" : "Add funding"}
          description={
            state === "AWAITING_FUNDING"
              ? "A separate decision from the mandate. This is what activates the engagement."
              : "Each top-up is its own authorization. It does not change the budget."
          }
        >
          {!can.fund ? (
            <OwnerOnly what="authorize funding" />
          ) : !wallet.isSimulated ? (
            <ChainFundingForm
              key={detail.fundings.length}
              engagementId={engagement.id}
              idempotencyKey={randomUUID()}
              assetCode={assetLabel(wallet.asset.code)}
              walletAddress={wallet.providerRef}
              fundingWallet={detail.fundingWallet}
              suggestedAmount={
                mandate ? unitsToDecimalString(mandate.totalAuthorizedUnits, mandate.asset.decimals) : ""
              }
              submitLabel={state === "AWAITING_FUNDING" ? "Confirm funding" : "Confirm top-up"}
            />
          ) : master <= 0n ? (
            <div className="space-y-3">
              <p className="text-sm leading-relaxed text-ink-soft">
                Your {engagement.rail ? railLabel(engagement.rail) : ""} master account is empty, so
                there is nothing to allocate.
              </p>
              <Button asChild variant="outline" size="lg" className="h-10 px-4">
                <Link href="/wallets">Go to wallets</Link>
              </Button>
            </div>
          ) : (
            <FundingForm
              // A new key per page render: each authorization is identified once.
              key={detail.fundings.length}
              engagementId={engagement.id}
              idempotencyKey={randomUUID()}
              assetCode={assetLabel(wallet.asset.code)}
              availableLabel={formatUnits(master, wallet.asset)}
              suggestedAmount={suggested}
              submitLabel={state === "AWAITING_FUNDING" ? "Authorize funding" : "Authorize top-up"}
            />
          )}
          {mandate && wallet.balanceUnits > mandate.totalAuthorizedUnits ? (
            <p className="mt-4 text-sm text-muted-foreground">
              The wallet holds more than the budget allows to be spent. The extra can&apos;t be used
              unless you approve a higher budget.
            </p>
          ) : null}
        </Panel>
      ) : null}

      {detail.fundings.length > 0 ? (
        <Panel title="Funding authorizations" description="Every transfer into this wallet, each authorized by a person.">
          <ul className="-my-3 divide-y divide-border">
            {detail.fundings.map((funding) => (
              <li key={funding.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="figure text-sm text-foreground">
                    {wallet ? formatUnits(funding.amountUnits, wallet.asset) : funding.amountUnits.toString()}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {dateTimeFormat.format(funding.authorizedAt)}
                    {funding.failureReason ? ` · ${funding.failureReason}` : ""}
                  </p>
                  {funding.transactionHash ? (
                    <ChainLink value={funding.transactionHash} short className="text-xs text-muted-foreground" />
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {funding.isSimulated ? <SimulatedBadge /> : null}
                  <span
                    className={
                      funding.status === "executed"
                        ? "text-sm text-brand"
                        : funding.status === "failed"
                          ? "text-sm text-destructive"
                          : "text-sm text-muted-foreground"
                    }
                  >
                    {funding.status === "executed"
                      ? "Completed"
                      : funding.status === "failed"
                        ? "Failed · no funds moved"
                        : "Authorized"}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel title="History" description="Every change of state, in order.">
        <ol className="space-y-4">
          {detail.events.map((event) => (
            <li key={event.id} className="flex gap-3">
              <span className="mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-sm text-foreground">
                  {ENGAGEMENT_STATE_LABELS[event.toState]}
                  {event.note ? <span className="text-muted-foreground"> · {event.note}</span> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {dateTimeFormat.format(event.createdAt)} · {event.actorName ?? "905 Finance"}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </Panel>

      {statement && (ended || statement.fundedUnits > 0n) ? (
        <Panel
          title={ended ? "Final financial record" : "Financial record so far"}
          description="From the platform's own books: what was authorized in, what was paid out, and what is left."
          action={
            <Button asChild variant="ghost" size="lg" className="h-9 px-3">
              <a href={`/engagements/${engagement.id}/statement`} download>
                Download
              </a>
            </Button>
          }
        >
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 lg:grid-cols-4">
            {(
              [
                ["Funded", statement.fundedUnits],
                ["Paid to seller", statement.spentUnits],
                ["Returned to you", statement.returnedUnits],
                ["Still in wallet", statement.heldUnits],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="eyebrow">{label}</dt>
                <dd className="figure mt-1 text-base whitespace-nowrap text-foreground">
                  {formatUnits(value, statement.asset)}
                </dd>
              </div>
            ))}
          </dl>
          <p className={`mt-4 text-sm ${statement.reconciles ? "text-muted-foreground" : "text-warn"}`}>
            {statement.reconciles
              ? "The figures reconcile: funded equals paid, returned and held."
              : "The figures do not reconcile. This needs looking at before anything else is done."}
            {statement.isSimulated ? " These are test funds." : " Real test assets on GOAT Testnet3."}
          </p>
          {statement.unresolved > 0 ? (
            <p className="mt-2 text-sm text-warn">
              {statement.unresolved} {statement.unresolved === 1 ? "payment has" : "payments have"} an
              outcome that is not settled yet. Reconcile under Purchases above.
            </p>
          ) : null}

          {statement.returns.length > 0 ? (
            <ul className="mt-5 divide-y divide-border border-t border-border">
              {statement.returns.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3 text-sm">
                  <span>
                    <span className="figure text-foreground">{formatUnits(entry.amountUnits, statement.asset)}</span>{" "}
                    <span className="text-muted-foreground">· {dateTimeFormat.format(entry.at)}</span>
                    {entry.reference ? (
                      <ChainLink value={entry.reference} short className="ml-2 text-xs text-muted-foreground" />
                    ) : null}
                    {entry.note ? <span className="mt-0.5 block text-xs text-muted-foreground">{entry.note}</span> : null}
                  </span>
                  <span
                    className={
                      entry.status === "executed"
                        ? "text-brand"
                        : entry.status === "failed"
                          ? "text-destructive"
                          : "text-warn"
                    }
                  >
                    {RETURN_LABELS[entry.status] ?? entry.status}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {ended && statement.heldUnits > 0n ? (
            <div className="mt-5 border-t border-border pt-5">
              <p className="text-sm font-medium text-foreground">Unused funds</p>
              {!can.fund ? (
                <div className="mt-2">
                  <OwnerOnly what="return unused funds" />
                </div>
              ) : statement.canReturn ? (
                <div className="mt-3">
                  <ReturnFundsForm
                    key={statement.returns.length}
                    engagementId={engagement.id}
                    idempotencyKey={randomUUID()}
                    amountLabel={formatUnits(statement.heldUnits, statement.asset)}
                    destination={
                      statement.isSimulated
                        ? "your master account"
                        : `your funding wallet ${detail.fundingWallet ?? ""}`
                    }
                  />
                </div>
              ) : (
                <div className="mt-2 space-y-3">
                  <p className="text-sm text-ink-soft">{statement.returnBlockedBy}</p>
                  {statement.returns.some((entry) => entry.status === "sent") ? (
                    <CheckReturnForm engagementId={engagement.id} />
                  ) : null}
                </div>
              )}
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Funds are never moved to another engagement, and never returned without your
                authorization.
              </p>
            </div>
          ) : null}
        </Panel>
      ) : null}

      {!ended ? (
        <Panel
          title="End engagement"
          description="Either ends the agent's authority immediately and is final. Unused funds stay put until you return them."
        >
          {can.terminate ? (
            <div className="flex flex-wrap items-start gap-4">
              {state === "ACTIVE" || state === "PAUSED_FOR_APPROVAL" ? (
                <CompleteEngagementForm engagementId={engagement.id} />
              ) : null}
              <CancelEngagementForm engagementId={engagement.id} />
            </div>
          ) : (
            <OwnerOnly what="end an engagement" />
          )}
        </Panel>
      ) : null}
    </div>
  );
}

export default function EngagementPage(props: PageProps<"/engagements/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <EngagementContent {...props} />
    </Suspense>
  );
}
