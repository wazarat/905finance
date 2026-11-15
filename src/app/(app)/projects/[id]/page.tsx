import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { PageHeader, Panel } from "@/components/app/page-header";
import { CapabilityChip, Web3Badge } from "@/components/sellers/badges";
import { Button } from "@/components/ui/button";
import { capabilitiesForProject, getFixture } from "@/lib/capabilities";
import { ChainLink } from "@/components/goat/chain-link";
import { isRepositoryCapability, parseGitHubRepository } from "@/lib/repository";
import { roleHasPermission } from "@/server/authz";
import { isAppError } from "@/server/errors";
import { requireWorkspace } from "@/server/page-context";
import { getProject, listProjectFiles } from "@/server/projects";
import { targetOf } from "@/server/testing/jobs";
import { DeleteProjectForm } from "./delete-project-form";

export const metadata: Metadata = { title: "Project" };

const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words text-foreground">{children}</dd>
    </div>
  );
}

async function ProjectContent({ params }: PageProps<"/projects/[id]">) {
  const { id } = await params;
  const { actor, workspace } = await requireWorkspace();

  const project = await getProject(actor, id).catch((error: unknown) => {
    // A project in someone else's organization is indistinguishable from a missing one.
    if (isAppError(error) && (error.code === "not_found" || error.code === "forbidden")) notFound();
    throw error;
  });

  const own = project.sourceType !== "fixture";
  // What is shared from a project of your own is read, never run, so only the first looks apply to it.
  const applicable = capabilitiesForProject(project.hasWeb3).filter((capability) => !own || isRepositoryCapability(capability.key));
  const readable = await Promise.all(applicable.map(async (capability) => !own || (await targetOf(project, capability.key)) !== null));
  const capabilities = applicable.filter((_, index) => readable[index]);
  const waiting = applicable.filter((_, index) => !readable[index]);
  const fixture = project.fixtureKey ? getFixture(project.fixtureKey) : undefined;
  const files = project.sourceType === "fixture" ? [] : await listProjectFiles(actor, project.id);
  const canDelete = roleHasPermission(workspace.role, "project.delete");

  return (
    <div className="space-y-8">
      <Link
        href="/projects"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Projects
      </Link>

      <PageHeader
        title={project.name}
        description={project.description || undefined}
        actions={
          <Button asChild size="lg" className="h-10 px-4">
            <Link href={`/agents${project.hasWeb3 ? "?web3=yes" : ""}`}>Find an agent</Link>
          </Button>
        }
      />

      <Panel title="Details">
        <dl className="-my-3 divide-y divide-border">
          <Row label="Source">
            {project.sourceType === "fixture" ? (
              <>
                Bundled fixture · {fixture?.label ?? project.fixtureKey}
                {fixture ? <span className="block text-muted-foreground">{fixture.description}</span> : null}
              </>
            ) : (
              <>
                Your own project
                <span className="mt-1 block text-muted-foreground">
                  What you share is read, never run. Tests that execute code are for the bundled projects.
                </span>
              </>
            )}
          </Row>
          {project.sourceType !== "fixture" ? (
            <>
              <Row label="Repository">
                {project.repositoryUrl ? (
                  <>
                    <span className="figure text-[0.8125rem] break-all">{project.repositoryUrl}</span>
                    {parseGitHubRepository(project.repositoryUrl) ? null : (
                      <span className="mt-1 block text-warn">
                        Only a public GitHub repository can be read. Nothing can be bought for this address.
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground">None shared</span>
                )}
              </Row>
              <Row label="Source files">
                {files.length > 0 ? (
                  <ul className="space-y-0.5">
                    {files.map((file) => (
                      <li key={file.id} className="figure text-[0.8125rem]">
                        {file.name} <span className="text-muted-foreground">· {Math.ceil(file.bytes / 1024)} KB</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-muted-foreground">None shared</span>
                )}
              </Row>
              <Row label="Contract addresses">
                {project.contractAddresses.length > 0 ? (
                  <ul className="space-y-0.5">
                    {project.contractAddresses.map((address) => (
                      <li key={address} className="text-[0.8125rem]">
                        <ChainLink value={address} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-muted-foreground">None shared</span>
                )}
              </Row>
            </>
          ) : null}
          <Row label="Website">
            {project.applicationUrl ? (
              <span className="figure text-[0.8125rem]">{project.applicationUrl}</span>
            ) : (
              <span className="text-muted-foreground">None provided</span>
            )}
          </Row>
          <Row label="Testing objectives">
            {project.testingObjectives || <span className="text-muted-foreground">None provided</span>}
          </Row>
          <Row label="Web3 components">
            {project.hasWeb3 ? (
              <span className="inline-flex items-center gap-2">
                Yes <Web3Badge />
              </span>
            ) : (
              "No"
            )}
          </Row>
          <Row label="Testing authorized">
            Confirmed {dateTimeFormat.format(project.testingAuthorizedAt)}
          </Row>
        </dl>
      </Panel>

      <Panel
        title="Testing available for this project"
        description={
          own
            ? "First looks, which read what this project shares."
            : project.hasWeb3
              ? "Conventional software testing, plus smart-contract testing."
              : "Conventional software testing."
        }
      >
        {capabilities.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {capabilities.map((capability) => (
              <CapabilityChip key={capability.key} capability={capability.key} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-warn">Nothing this project shares can be read yet.</p>
        )}
        {waiting.length > 0 ? (
          <div className="mt-4">
            <p className="text-sm text-muted-foreground">Nothing is shared for these yet:</p>
            <div className="mt-2 flex flex-wrap gap-1.5 opacity-60">
              {waiting.map((capability) => (
                <CapabilityChip key={capability.key} capability={capability.key} />
              ))}
            </div>
          </div>
        ) : null}
        <p className="mt-4 text-sm text-muted-foreground">
          These are the kinds of testing a seller can offer for this project. Choose a seller from
          the marketplace to see services and prices.
        </p>
      </Panel>

      {canDelete ? (
        <Panel title="Delete project" description="Removes the project and its settings.">
          <DeleteProjectForm projectId={project.id} projectName={project.name} />
        </Panel>
      ) : null}
    </div>
  );
}

export default function ProjectPage(props: PageProps<"/projects/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ProjectContent {...props} />
    </Suspense>
  );
}
