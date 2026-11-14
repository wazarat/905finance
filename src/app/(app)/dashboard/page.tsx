import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { EmptyState, NotYetActive, PageHeader, Panel, StatTile } from "@/components/app/page-header";
import { Web3Badge } from "@/components/sellers/badges";
import { Button } from "@/components/ui/button";
import { requireWorkspace } from "@/server/page-context";
import { listProjects } from "@/server/projects";
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
        <StatTile label="Active engagements" value={null} note="Engagements are not yet active." />
        <StatTile label="Available wallet funds" value={null} note="No wallet is connected." />
        <StatTile label="Pending approvals" value={null} note="Nothing can request approval yet." />
      </section>

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
