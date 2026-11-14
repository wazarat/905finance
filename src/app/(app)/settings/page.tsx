import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { NotYetActive, PageHeader, Panel } from "@/components/app/page-header";
import { ListingStatusBadge, NotConnectedBadge } from "@/components/sellers/badges";
import { Button } from "@/components/ui/button";
import { requireWorkspace } from "@/server/page-context";
import { EnableRoleForm } from "../enable-role-form";

export const metadata: Metadata = { title: "Settings" };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words text-foreground">{children}</dd>
    </div>
  );
}

async function SettingsContent() {
  const { user, workspace } = await requireWorkspace();
  const isOwner = workspace.role === "owner";

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

      <Panel title="Connections" action={<NotYetActive />}>
        <dl className="-my-3 divide-y divide-border">
          <Row label="Master funding wallet">
            <NotConnectedBadge />
          </Row>
          <Row label="Qatom account">
            <NotConnectedBadge />
          </Row>
          <Row label="GOAT Network wallet">
            <NotConnectedBadge />
          </Row>
        </dl>
        <p className="mt-4 text-sm text-muted-foreground">
          Wallets and payment accounts are connected here once funding is available. Connecting an
          account will never authorize spending by itself.
        </p>
      </Panel>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <SettingsContent />
    </Suspense>
  );
}
