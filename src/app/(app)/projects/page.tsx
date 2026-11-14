import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { EmptyState, PageHeader } from "@/components/app/page-header";
import { Web3Badge } from "@/components/sellers/badges";
import { Button } from "@/components/ui/button";
import { getFixture } from "@/lib/capabilities";
import { requireWorkspace } from "@/server/page-context";
import { listProjects } from "@/server/projects";

export const metadata: Metadata = { title: "Projects" };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

async function ProjectsContent() {
  const { actor, workspace } = await requireWorkspace();
  const projects = await listProjects(actor, workspace.organization.id);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Buying"
        title="Projects"
        description="Each project describes one piece of software you want tested."
        actions={
          <Button asChild size="lg" className="h-10 px-4">
            <Link href="/projects/new">New project</Link>
          </Button>
        }
      />

      {projects.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8">
          <EmptyState
            title="No projects yet"
            body="Create a project to describe what should be tested. Conventional software and smart contracts use the same form."
            action={
              <Button asChild size="lg" className="h-10 px-4">
                <Link href="/projects/new">New project</Link>
              </Button>
            }
          />
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {projects.map((project) => (
            <li key={project.id}>
              <Link
                href={`/projects/${project.id}`}
                className="flex flex-col gap-2 p-5 transition-colors outline-none hover:bg-accent/40 focus-visible:bg-accent/40 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{project.name}</p>
                  <p className="mt-0.5 truncate text-sm text-muted-foreground">
                    {project.sourceType === "fixture"
                      ? `Fixture · ${getFixture(project.fixtureKey ?? "")?.label ?? project.fixtureKey}`
                      : project.repositoryUrl}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {project.hasWeb3 ? <Web3Badge /> : null}
                  <span className="text-xs text-muted-foreground">
                    Created {dateFormat.format(project.createdAt)}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ProjectsContent />
    </Suspense>
  );
}
