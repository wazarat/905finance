import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { NotYetActive, PageHeader, Panel } from "@/components/app/page-header";
import { ListingStatusBadge } from "@/components/sellers/badges";
import { Button } from "@/components/ui/button";
import { NETWORK_ROLES } from "@/lib/capabilities";
import { requireWorkspace } from "@/server/page-context";
import { ChainLink } from "@/components/goat/chain-link";
import { goatLiveConfig } from "@/server/goat/live";
import { getOwnBuyerIdentity } from "@/server/identity";
import { getQatomStatus } from "@/server/qatom/connection";
import { isPlatformOperator } from "@/server/reputation";
import { ERC8004_TESTNET3, agentExplorerLink } from "@/lib/goat";
import { getIntegrationStatus } from "@/server/status";
import { EnableRoleForm } from "../enable-role-form";
import { BuyerIdentityControls, LinkBuyerIdentityForm } from "./identity-forms";
import { ConnectQatomForm, DisconnectQatomForm } from "./qatom-forms";

export const metadata: Metadata = { title: "Settings" };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words text-foreground">{children}</dd>
    </div>
  );
}

const STATE_LABELS = { live: "Live", partial: "Partly set up", simulated: "Test mode", off: "Off" } as const;
const STATE_TONE = {
  live: "text-brand",
  partial: "text-warn",
  simulated: "text-warn",
  off: "text-destructive",
} as const;

const NOTICES: Record<string, string> = {
  connected: "Qatom account linked.",
  cancelled: "The Qatom sign-in was cancelled. Nothing was linked.",
  failed: "The Qatom sign-in could not be completed. Nothing was linked.",
};

async function SettingsContent({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { actor, user, workspace } = await requireWorkspace();
  const isOwner = workspace.role === "owner";
  const raw = (await searchParams).qatom;
  const notice = typeof raw === "string" ? raw : "";
  // Linking Qatom is for organizations that buy: it carries their agents' messages.
  const qatom = workspace.buyerProfile ? await getQatomStatus(actor, workspace.organization.id) : null;
  const goat = goatLiveConfig();
  const status = await getIntegrationStatus(actor, workspace.organization.id);
  const buying = workspace.buyerProfile ? await getOwnBuyerIdentity(actor, workspace.organization.id) : null;
  const operator = await isPlatformOperator(actor);

  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Account" title="Settings" description="Your identity, organization and connections." />

      <Panel title="Identity">
        <dl className="-my-3 divide-y divide-border">
          <Row label="Name">{user.displayName ?? <span className="text-muted-foreground">Not set</span>}</Row>
          <Row label="Email">{user.email ?? <span className="text-muted-foreground">None on file</span>}</Row>
        </dl>
      </Panel>

      <Panel title="Organization">
        <dl className="-my-3 divide-y divide-border">
          <Row label="Name">{workspace.organization.name}</Row>
          <Row label="Account type">
            <span className="capitalize">{workspace.organization.accountType}</span>
          </Row>
          <Row label="Your role">
            <span className="capitalize">{workspace.role}</span>
          </Row>
        </dl>
      </Panel>

      <Panel title="Roles" description="An organization can buy, sell, or both.">
        <div className="space-y-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium text-foreground">Buyer</p>
              <p className="text-sm text-muted-foreground">Create projects and hire agents.</p>
            </div>
            {workspace.buyerProfile ? (
              <span className="text-sm text-brand">Enabled</span>
            ) : isOwner ? (
              <EnableRoleForm role="buyer" label="Enable buying" />
            ) : (
              <span className="text-sm text-muted-foreground">Owner can enable</span>
            )}
          </div>
          <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium text-foreground">Seller</p>
              <p className="text-sm text-muted-foreground">List an agent's services.</p>
            </div>
            {workspace.sellerProfile ? (
              <div className="flex items-center gap-3">
                <ListingStatusBadge status={workspace.sellerProfile.status} />
                <Button asChild variant="outline" size="lg" className="h-9 px-3">
                  <Link href="/seller/listing">Manage listing</Link>
                </Button>
              </div>
            ) : isOwner ? (
              <EnableRoleForm role="seller" label="Create a seller listing" />
            ) : (
              <span className="text-sm text-muted-foreground">Owner can enable</span>
            )}
          </div>
        </div>
      </Panel>

      <Panel
        title="What is connected"
        description="What each outside system is really doing in this deployment. Nothing here is assumed."
      >
        <ul className="-my-4 divide-y divide-border">
          {status.map((line) => (
            <li key={line.name} className="grid gap-2 py-4 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
              <div>
                <p className="text-sm font-medium text-foreground">{line.name}</p>
                <p className="text-xs text-muted-foreground">{line.role}</p>
              </div>
              <div className="min-w-0">
                <p className="text-sm text-ink-soft">
                  <span className={STATE_TONE[line.state]}>{STATE_LABELS[line.state]}.</span> {line.summary}
                </p>
                {line.missing.length > 0 ? (
                  <p className="figure mt-1 text-xs break-words text-muted-foreground">
                    Still needed: {line.missing.join("; ")}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      {qatom ? (
        <Panel
          title="Qatom"
          description={`${NETWORK_ROLES.communication.role}. ${NETWORK_ROLES.communication.detail}`}
        >
          {NOTICES[notice] ? (
            <p
              className={
                notice === "connected"
                  ? "mb-5 rounded-lg border border-brand/30 bg-brand-dim px-4 py-3 text-sm text-foreground"
                  : "mb-5 rounded-lg border border-warn/30 bg-warn-dim px-4 py-3 text-sm text-foreground"
              }
            >
              {NOTICES[notice]}
            </p>
          ) : null}
          {qatom.connected || qatom.needsReconnect ? (
            <>
              <dl className="-my-3 divide-y divide-border">
                <Row label="Status">
                  {qatom.connected ? (
                    <span className="text-brand">Linked</span>
                  ) : (
                    <span className="text-warn">
                      Sign-in expired{qatom.lastError ? `: ${qatom.lastError}` : ""}
                    </span>
                  )}
                </Row>
                <Row label="Qatom account">{qatom.email ?? "Not reported by Qatom"}</Row>
                <Row label="Agent twin">
                  <span className="figure break-all">{qatom.agentTwin ?? "Not reported by Qatom"}</span>
                </Row>
                <Row label="Primary twin">
                  <span className="figure break-all">{qatom.primaryTwin ?? "Not reported by Qatom"}</span>
                </Row>
              </dl>
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                Your agents send their messages to sellers through this account, using free catalog
                items only. Linking it authorizes no payment: an agent here cannot approve a Qatom
                charge, and payments are made on GOAT Network under each engagement&apos;s mandate.
              </p>
              {qatom.canManage ? (
                <div className="mt-5 flex flex-wrap gap-3 border-t border-border pt-5">
                  {qatom.needsReconnect ? <ConnectQatomForm label="Sign in to Qatom again" /> : null}
                  <DisconnectQatomForm />
                </div>
              ) : null}
            </>
          ) : (
            <div className="space-y-4">
              <p className="max-w-2xl text-sm leading-relaxed text-ink-soft">
                Not linked. Until it is, your agents reach sellers over the built-in
                channel. Linking sends you to Qatom to sign in there; this application never sees
                your Qatom sign-in. It authorizes no payment.
              </p>
              {qatom.canManage ? (
                <ConnectQatomForm />
              ) : (
                <p className="text-sm text-muted-foreground">Only the organization&apos;s owner can link Qatom.</p>
              )}
            </div>
          )}
        </Panel>
      ) : null}

      {buying ? (
        <Panel
          title="Buying agent identity"
          description="Your purchasing agent's ERC-8004 identity on GOAT Testnet3. Ratings you give are made in its name."
        >
          {buying.identity ? (
            <div className="space-y-5">
              <dl className="-my-3 divide-y divide-border">
                <Row label="Agent">
                  <a
                    href={agentExplorerLink(buying.identity.agentId)}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline decoration-border underline-offset-4 hover:decoration-foreground"
                  >
                    Agent {buying.identity.agentId}
                  </a>
                </Row>
                <Row label="Owner">
                  <ChainLink value={buying.identity.ownerAddress} short />
                </Row>
                <Row label="Status">
                  <span className={buying.identity.confirmed ? "text-brand" : "text-warn"}>
                    {buying.identity.confirmed ? "Confirmed by its registration" : "Unconfirmed claim"}
                  </span>
                </Row>
              </dl>
              {!buying.identity.confirmed ? (
                <div className="rounded-lg border border-warn/30 bg-warn-dim p-4 text-sm leading-relaxed text-ink-soft">
                  <p className="font-medium text-foreground">Not confirmed yet</p>
                  <p className="mt-1">
                    Anyone can type an agent id, so a link counts only when the agent points back. Set the
                    agent&apos;s registration on GOAT to the address below, then choose Read again.
                  </p>
                  <p className="figure mt-3 text-xs break-all text-foreground select-all">{buying.registrationUrl}</p>
                </div>
              ) : null}
              {buying.canManage ? (
                <div className="grid gap-6 border-t border-border pt-5 sm:grid-cols-2">
                  <BuyerIdentityControls />
                  <LinkBuyerIdentityForm currentAgentId={buying.identity.agentId} />
                </div>
              ) : null}
            </div>
          ) : (
            <div className="space-y-4">
              <p className="max-w-2xl text-sm leading-relaxed text-ink-soft">
                Not linked. Register an agent in the ERC-8004 Identity Registry on GOAT Testnet3 from your own
                wallet, using the address below as its registration, then enter the id the registry gives it.
                905 Finance holds no key to your wallet and does not register it for you.
              </p>
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Your buying agent&apos;s registration document</dt>
                  <dd className="figure mt-1 text-xs break-all text-foreground select-all">{buying.registrationUrl}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Identity Registry on GOAT Testnet3</dt>
                  <dd className="mt-1 text-xs">
                    <ChainLink value={ERC8004_TESTNET3.identityRegistry} />
                    <span className="figure mt-1 block text-muted-foreground">register(string agentURI)</span>
                  </dd>
                </div>
              </dl>
              {buying.canManage ? (
                <LinkBuyerIdentityForm currentAgentId={null} />
              ) : (
                <p className="text-sm text-muted-foreground">Only the organization&apos;s owner can link an identity.</p>
              )}
            </div>
          )}
        </Panel>
      ) : null}

      {operator ? (
        <Panel
          title="905 Finance validation"
          description="You validate for 905 Finance: problems that buyers report, and low ratings, come to you to decide."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/validation">Open the queue</Link>
            </Button>
          }
        >
          <p className="text-sm leading-relaxed text-muted-foreground">
            You cannot decide a case that involves an organization you belong to.
          </p>
        </Panel>
      ) : null}

      <Panel
        title="GOAT Network"
        description={`${NETWORK_ROLES.settlement.role}. ${NETWORK_ROLES.settlement.detail}`}
        action={goat ? null : <NotYetActive>Test mode</NotYetActive>}
      >
        {goat ? (
          <>
            <dl className="-my-3 divide-y divide-border">
              <Row label="Settlement">
                <span className="text-brand">Real, on GOAT Testnet3</span>
              </Row>
              <Row label="Paid in">
                {goat.token.symbol} · <ChainLink value={goat.token.address} short />
              </Row>
            </dl>
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
              New engagements with a seller that has a confirmed GOAT identity and receiving wallet
              get a real wallet and pay through GOAT Flow. Others use test funds. Testnet3 assets are
              for testing and have no monetary value. Your funding wallet is your own: you fund each
              engagement by sending to its wallet yourself.
            </p>
          </>
        ) : (
          <p className="text-sm leading-relaxed text-muted-foreground">
            Seller identity and reputation are read from GOAT Testnet3 today. Wallets and payments
            use test funds here until on-chain settlement is switched on for this deployment.
          </p>
        )}
      </Panel>
    </div>
  );
}

export default function SettingsPage({ searchParams }: PageProps<"/settings">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <SettingsContent searchParams={searchParams} />
    </Suspense>
  );
}
