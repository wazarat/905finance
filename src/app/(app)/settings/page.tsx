import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { NotYetActive, PageHeader, Panel } from "@/components/app/page-header";
import { ListingStatusBadge } from "@/components/sellers/badges";
import { Button } from "@/components/ui/button";
import { NETWORK_ROLES } from "@/lib/capabilities";
import { requireWorkspace } from "@/server/page-context";
import { getQatomStatus } from "@/server/qatom/connection";
import { EnableRoleForm } from "../enable-role-form";
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
                Not linked. Until it is, your agents reach the sample sellers over the in-app demo
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

      <Panel title="GOAT Network" action={<NotYetActive />}>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {NETWORK_ROLES.settlement.role}. {NETWORK_ROLES.settlement.detail} Wallets and payments are
          simulated until the GOAT integration is connected. Connecting an account will never
          authorize spending by itself.
        </p>
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
