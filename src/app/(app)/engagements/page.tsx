import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/app/page-header";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { EngagementStateBadge } from "@/components/engagements/badges";
import { SampleBadge } from "@/components/sellers/badges";
import { Button } from "@/components/ui/button";
import { SETTLEMENT_RAIL, railLabel } from "@/lib/capabilities";
import { formatUnits } from "@/lib/units";
import { listEngagements } from "@/server/engagements";
import { requireWorkspace } from "@/server/page-context";
import { EnableRoleForm } from "../enable-role-form";

export const metadata: Metadata = { title: "Engagements" };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

async function EngagementsContent() {
  const { actor, workspace } = await requireWorkspace();

  if (!workspace.buyerProfile) {
    return (
      <div className="space-y-8">
        <PageHeader
          eyebrow="Buying"
          title="Engagements"
          description="Engagements belong to the buying side of your organization. Add the buyer role to hire agents."
        />
        {workspace.role === "owner" ? (
          <EnableRoleForm role="buyer" label="Enable buying" />
        ) : (
          <p className="text-sm text-muted-foreground">Ask your organization&apos;s owner to enable buying.</p>
        )}
      </div>
    );
  }

  const engagements = await listEngagements(actor, workspace.organization.id);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Buying"
        title="Engagements"
        description="One engagement per seller you hire. Each has its own mandate and its own wallet."
        actions={
          <Button asChild size="lg" className="h-10 px-4">
            <Link href="/agents">Choose a seller</Link>
          </Button>
        }
      />

      {engagements.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8">
          <EmptyState
            title="No engagements yet"
            body="Browse the marketplace, pick the seller you want, and set up an engagement. Nothing is contacted or spent until you authorize it."
            action={
              <Button asChild size="lg" className="h-10 px-4">
                <Link href="/agents">Explore agents</Link>
              </Button>
            }
          />
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {engagements.map((engagement) => (
            <li key={engagement.id}>
              <Link
                href={`/engagements/${engagement.id}`}
                className="grid gap-3 p-5 transition-colors outline-none hover:bg-accent/40 focus-visible:bg-accent/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-medium text-foreground">{engagement.sellerName}</p>
                    <EngagementStateBadge state={engagement.state} />
                    {engagement.sellerIsSample ? <SampleBadge /> : null}
                  </div>
                  <p className="truncate text-sm text-muted-foreground">
                    {engagement.projectName}
                    {engagement.rail && engagement.rail !== SETTLEMENT_RAIL
                      ? ` · ${railLabel(engagement.rail)}`
                      : ""}
                    {" · started "}
                    {dateFormat.format(engagement.createdAt)}
                  </p>
                </div>
                <dl className="flex gap-8 sm:text-right">
                  <div>
                    <dt className="eyebrow">Budget</dt>
                    <dd className="figure mt-1 text-sm text-foreground">
                      {engagement.asset && engagement.totalAuthorizedUnits !== null
                        ? formatUnits(engagement.totalAuthorizedUnits, engagement.asset)
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="eyebrow">Wallet</dt>
                    <dd className="figure mt-1 text-sm text-foreground">
                      {engagement.asset && engagement.walletBalanceUnits !== null
                        ? formatUnits(engagement.walletBalanceUnits, engagement.asset)
                        : "—"}
                    </dd>
                  </div>
                </dl>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function EngagementsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <EngagementsContent />
    </Suspense>
  );
}
