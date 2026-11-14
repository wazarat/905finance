import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { EmptyState, NotYetActive, PageHeader, Panel, StatTile } from "@/components/app/page-header";
import { ListingStatusBadge, NotConnectedBadge } from "@/components/sellers/badges";
import { Button } from "@/components/ui/button";
import { requireWorkspace } from "@/server/page-context";
import { formatUnits } from "@/lib/units";
import { getSellerListing, listingGaps } from "@/server/sellers";
import { getSellerEarnings } from "@/server/transactions";
import { EnableRoleForm } from "../enable-role-form";

export const metadata: Metadata = { title: "Seller dashboard" };

async function SellerDashboardContent() {
  const { actor, workspace } = await requireWorkspace();
  const listing = await getSellerListing(actor, workspace.organization.id);

  if (!listing) {
    return (
      <div className="space-y-8">
        <PageHeader
          eyebrow="Selling"
          title="Sell your agent's services"
          description="List what your agent does, price it per use, and receive purchases from authorized buyer agents."
        />
        {workspace.role === "owner" ? (
          <EnableRoleForm role="seller" label="Create a seller listing" />
        ) : (
          <p className="text-sm text-muted-foreground">Ask your organization's owner to enable selling.</p>
        )}
      </div>
    );
  }

  const { profile, offerings } = listing;
  const gaps = listingGaps(listing);
  const earnings = await getSellerEarnings(actor, workspace.organization.id);

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Selling"
        title={profile.displayName}
        description={profile.tagline || "Your seller listing on 905 Finance."}
        actions={
          <>
            <Button asChild variant="outline" size="lg" className="h-10 px-4">
              <Link href="/seller/listing/preview">Preview</Link>
            </Button>
            <Button asChild size="lg" className="h-10 px-4">
              <Link href="/seller/listing">Edit listing</Link>
            </Button>
          </>
        }
      />

      <section aria-label="Overview" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="eyebrow">Listing status</p>
          <div className="mt-3">
            <ListingStatusBadge status={profile.status} />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            {profile.status === "draft"
              ? gaps.length > 0
                ? `${gaps.length} ${gaps.length === 1 ? "step" : "steps"} left before you can submit.`
                : "Ready to submit for activation."
              : profile.status === "pending_review"
                ? "Awaiting activation."
                : profile.status === "active"
                  ? "Visible in the marketplace."
                  : "Hidden from buyers."}
          </p>
        </div>
        <StatTile label="Service offerings" value={String(offerings.length)} />
        <StatTile
          label="Jobs"
          value={String(earnings?.jobs ?? 0)}
          note="Purchases paid for by buyer agents."
        />
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="eyebrow">Revenue</p>
          {earnings && earnings.totals.length > 0 ? (
            <>
              <ul className="mt-3 space-y-1.5">
                {earnings.totals.map((total) => (
                  <li key={`${total.rail}-${total.asset.code}`} className="figure text-base text-foreground">
                    {formatUnits(total.spentUnits, total.asset)}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {earnings.totals.every((t) => t.isSimulated)
                  ? "Simulated. No real funds were received."
                  : "Per rail."}
              </p>
            </>
          ) : (
            <>
              <p className="figure mt-3 text-3xl text-muted-foreground">—</p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">No payments received.</p>
            </>
          )}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Agent identity" action={<NotYetActive />}>
          <dl className="-my-3 divide-y divide-border text-sm">
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="text-muted-foreground">ERC-8004 registration</dt>
              <dd>
                <NotConnectedBadge label="Not registered" />
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="text-muted-foreground">Receiving wallet</dt>
              <dd>
                <NotConnectedBadge />
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="text-muted-foreground">Qatom catalog</dt>
              <dd>
                <NotConnectedBadge label="Not published" />
              </dd>
            </div>
          </dl>
        </Panel>
        <Panel title="Payment activity" description="Payments from authorized buyer agents.">
          {earnings && earnings.recent.length > 0 ? (
            <ul className="-my-3 divide-y divide-border">
              {earnings.recent.map((payment) => (
                <li key={payment.id} className="space-y-1 py-3">
                  <div className="flex items-baseline justify-between gap-4">
                    <p className="text-sm text-foreground">{payment.offeringName}</p>
                    <p className="figure text-sm text-foreground">
                      {formatUnits(payment.amountUnits, payment.asset)}
                    </p>
                  </div>
                  <p className="figure text-xs break-all text-muted-foreground">{payment.providerRef}</p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="No payments yet"
              body="Payments from authorized buyer agents will be listed here with their provider references."
            />
          )}
        </Panel>
      </div>

      <Panel title="Jobs" action={<NotYetActive />}>
        <EmptyState
          title="No jobs yet"
          body="Active and completed jobs appear here once buyers can engage your agent."
        />
      </Panel>
    </div>
  );
}

export default function SellerDashboardPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <SellerDashboardContent />
    </Suspense>
  );
}
