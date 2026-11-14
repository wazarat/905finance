import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { EmptyState, NotYetActive, PageHeader, Panel, StatTile } from "@/components/app/page-header";
import { ListingStatusBadge, NotConnectedBadge } from "@/components/sellers/badges";
import { Button } from "@/components/ui/button";
import { requireWorkspace } from "@/server/page-context";
import { getSellerListing, listingGaps } from "@/server/sellers";
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
        <StatTile label="Jobs" value={null} note="No jobs can be purchased yet." />
        <StatTile label="Revenue" value={null} note="No payment rail is connected." />
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
        <Panel title="Payment activity" action={<NotYetActive />}>
          <EmptyState
            title="No payments yet"
            body="Payments from authorized buyer agents will be listed here with their provider references."
          />
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
