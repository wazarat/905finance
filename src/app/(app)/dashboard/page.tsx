import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { EmptyState, NotYetActive, PageHeader, Panel, StatTile } from "@/components/app/page-header";
import { EngagementStateBadge } from "@/components/engagements/badges";
import { Web3Badge } from "@/components/sellers/badges";
import { Button } from "@/components/ui/button";
import { isTerminal } from "@/lib/engagement-state";
import { formatUnits } from "@/lib/units";
import { listApprovals } from "@/server/approvals";
import { listEngagements } from "@/server/engagements";
import { getSpendingTotals } from "@/server/transactions";
import { requireWorkspace } from "@/server/page-context";
import { listProjects } from "@/server/projects";
import { getWalletOverview } from "@/server/wallets";
import { EnableRoleForm } from "../enable-role-form";

export const metadata: Metadata = { title: "Dashboard" };

async function BuyerDashboardContent() {
  const { actor, user, workspace } = await requireWorkspace();

  if (!workspace.buyerProfile) {
    return (
      <div className="space-y-8">
        <PageHeader
          eyebrow="Buying"
          title="Buying isn't set up yet"
          description="Your organization currently sells on 905 Finance. Add the buyer role to create projects and hire agents."
        />
        {workspace.role === "owner" ? (
          <EnableRoleForm role="buyer" label="Enable buying" />
        ) : (
          <p className="text-sm text-muted-foreground">Ask your organization's owner to enable buying.</p>
        )}
      </div>
    );
  }

  const projects = await listProjects(actor, workspace.organization.id);
  const engagements = await listEngagements(actor, workspace.organization.id);
  const wallets = await getWalletOverview(actor, workspace.organization.id);
  const activeCount = engagements.filter((e) => e.state === "ACTIVE").length;
  const openCount = engagements.filter((e) => !isTerminal(e.state)).length;
  const fundedRails = wallets.rails.filter((r) => r.masterAccountId !== null);
  const approvals = await listApprovals(actor, workspace.organization.id);
  const pendingApprovals = approvals.filter((a) => a.status === "pending");
  const spending = await getSpendingTotals(actor, workspace.organization.id);
  const firstName = user.displayName?.split(" ")[0];

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow={workspace.organization.name}
        title={firstName ? `Welcome, ${firstName}` : "Dashboard"}
        description="Your projects, engagements and spending in one place."
        actions={
          <>
            <Button asChild variant="outline" size="lg" className="h-10 px-4">
              <Link href="/agents">Explore agents</Link>
            </Button>
            <Button asChild size="lg" className="h-10 px-4">
              <Link href="/projects/new">New project</Link>
            </Button>
          </>
        }
      />

      <section aria-label="Overview" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Projects" value={String(projects.length)} />
        <StatTile
          label="Active engagements"
          value={String(activeCount)}
          note={
            openCount > activeCount
              ? `${openCount - activeCount} more being set up.`
              : "Authorized, funded and running."
          }
        />
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="eyebrow">Available wallet funds</p>
          {fundedRails.length === 0 ? (
            <>
              <p className="figure mt-3 text-3xl text-muted-foreground">—</p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                No master account set up yet.
              </p>
            </>
          ) : (
            <>
              <ul className="mt-3 space-y-1.5">
                {fundedRails.map((rail) => (
                  <li key={rail.rail} className="figure text-base text-foreground">
                    {formatUnits(rail.unallocatedUnits, rail.asset)}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Unallocated, per rail. Simulated.
              </p>
            </>
          )}
        </div>
        <Link
          href="/approvals"
          className={
            pendingApprovals.length > 0
              ? "rounded-xl border border-warn/40 bg-warn-dim p-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              : "rounded-xl border border-border bg-card p-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          }
        >
          <p className="eyebrow">Pending approvals</p>
          <p className="figure mt-3 text-3xl text-foreground">{pendingApprovals.length}</p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {pendingApprovals.length > 0
              ? "An agent is waiting for your decision."
              : "No agent is waiting on you."}
          </p>
        </Link>
      </section>

      {spending.length > 0 ? (
        <Panel
          title="Total spending"
          description="Confirmed payments by your agents, per rail."
          action={
            <Button asChild variant="ghost" size="lg" className="h-9 px-3">
              <Link href="/transactions">
                Transactions
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </Link>
            </Button>
          }
        >
          <ul className="flex flex-wrap gap-x-10 gap-y-3">
            {spending.map((total) => (
              <li key={`${total.rail}-${total.asset.code}`}>
                <p className="figure text-xl text-foreground">{formatUnits(total.spentUnits, total.asset)}</p>
                <p className="text-xs text-muted-foreground">{total.isSimulated ? "Simulated" : "Settled"}</p>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel
        title="Projects"
        description="The software you want tested."
        action={
          projects.length > 0 ? (
            <Button asChild variant="ghost" size="lg" className="h-9 px-3">
              <Link href="/projects">
                View all
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </Link>
            </Button>
          ) : null
        }
      >
        {projects.length === 0 ? (
          <EmptyState
            title="Create your first project"
            body="A project describes what should be tested and confirms you're authorized to have it tested. You'll attach it to an engagement when you hire an agent."
            action={
              <Button asChild size="lg" className="h-10 px-4">
                <Link href="/projects/new">New project</Link>
              </Button>
            }
          />
        ) : (
          <ul className="-my-2 divide-y divide-border">
            {projects.slice(0, 5).map((project) => (
              <li key={project.id}>
                <Link
                  href={`/projects/${project.id}`}
                  className="flex items-center justify-between gap-4 rounded-md py-3 outline-none hover:text-brand focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-foreground">{project.name}</span>
                    <span className="block truncate text-sm text-muted-foreground">
                      {project.sourceType === "fixture" ? "Bundled fixture" : project.repositoryUrl}
                    </span>
                  </span>
                  {project.hasWeb3 ? <Web3Badge /> : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Engagements"
        description="The sellers you've hired."
        action={
          engagements.length > 0 ? (
            <Button asChild variant="ghost" size="lg" className="h-9 px-3">
              <Link href="/engagements">
                View all
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </Link>
            </Button>
          ) : null
        }
      >
        {engagements.length === 0 ? (
          <EmptyState
            title="No engagements yet"
            body="Pick a seller from the marketplace to set one up. Nothing is contacted or spent until you authorize it."
            action={
              <Button asChild variant="outline" size="lg" className="h-10 px-4">
                <Link href="/agents">Explore agents</Link>
              </Button>
            }
          />
        ) : (
          <ul className="-my-2 divide-y divide-border">
            {engagements.slice(0, 5).map((engagement) => (
              <li key={engagement.id}>
                <Link
                  href={`/engagements/${engagement.id}`}
                  className="flex items-center justify-between gap-4 rounded-md py-3 outline-none hover:text-brand focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-foreground">
                      {engagement.sellerName}
                    </span>
                    <span className="block truncate text-sm text-muted-foreground">
                      {engagement.projectName}
                    </span>
                  </span>
                  <EngagementStateBadge state={engagement.state} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Recent testing jobs" action={<NotYetActive />}>
          <EmptyState
            title="No jobs have run"
            body="Jobs appear here once an authorized engagement purchases a test. Counts and results always come from real executions."
          />
        </Panel>
        <Panel title="Findings" action={<NotYetActive />}>
          <EmptyState
            title="No findings yet"
            body="Failures and security findings from completed jobs will be listed here with severity and evidence."
          />
        </Panel>
      </div>
    </div>
  );
}

export default function BuyerDashboardPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <BuyerDashboardContent />
    </Suspense>
  );
}
