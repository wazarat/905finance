import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeft, Check } from "lucide-react";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { NotYetActive, PageHeader, Panel } from "@/components/app/page-header";
import { CapabilityChip, SampleBadge } from "@/components/sellers/badges";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/money";
import { getPublicSellerBySlug } from "@/server/marketplace";
import { requireWorkspace } from "@/server/page-context";
import { listProjects } from "@/server/projects";

export const metadata: Metadata = { title: "Configure engagement" };

const NEXT_STEPS = [
  "Choose the project and the services the agent may buy",
  "Set a total budget, a per-purchase limit and an expiry",
  "Authorize the engagement",
  "Provision a dedicated wallet and separately approve its funding",
] as const;

/**
 * Lands here from "Select this seller". It confirms the human-made selection
 * and shows what comes next. It creates nothing: no engagement, wallet,
 * payment or agent message exists until engagements are switched on.
 */
async function ConfigureEngagementContent({ searchParams }: PageProps<"/engagements/new">) {
  const params = await searchParams;
  const slug = Array.isArray(params.seller) ? params.seller[0] : params.seller;
  const { actor, workspace } = await requireWorkspace();
  const seller = slug ? await getPublicSellerBySlug(slug) : null;

  if (!seller) {
    return (
      <div className="space-y-8">
        <PageHeader
          eyebrow="Engagement"
          title="Choose a seller first"
          description="An engagement is always with one seller that you pick yourself."
        />
        <Button asChild size="lg" className="h-10 px-4">
          <Link href="/agents">Explore agents</Link>
        </Button>
      </div>
    );
  }

  const projects = workspace.buyerProfile ? await listProjects(actor, workspace.organization.id) : [];

  return (
    <div className="space-y-8">
      <Link
        href={`/agents/${seller.slug}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to {seller.displayName}
      </Link>

      <PageHeader
        eyebrow="Engagement"
        title="Configure engagement"
        description="You've selected a seller. Nothing has been sent to it and nothing has been spent."
      />

      <Panel title="Selected seller" description="Chosen by you. An engagement cannot switch sellers.">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-lg font-semibold text-foreground">{seller.displayName}</p>
              {seller.isSample ? <SampleBadge /> : null}
            </div>
            <p className="text-sm text-muted-foreground">{seller.tagline}</p>
            <div className="flex flex-wrap gap-1.5">
              {seller.capabilities.map((capability) => (
                <CapabilityChip key={capability} capability={capability} />
              ))}
            </div>
          </div>
          <div className="shrink-0 sm:text-right">
            <p className="eyebrow">Services from</p>
            <p className="figure mt-1 text-lg text-foreground">
              {seller.startingPriceMinor !== null
                ? formatMoney(seller.startingPriceMinor, seller.startingPriceCurrency ?? "USD")
                : "—"}
            </p>
          </div>
        </div>
      </Panel>

      <Panel title="Project" description="The software this engagement would cover.">
        {projects.length === 0 ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              You don't have a project yet. Create one so it's ready to attach.
            </p>
            <Button asChild variant="outline" size="lg" className="h-10 px-4">
              <Link href="/projects/new">New project</Link>
            </Button>
          </div>
        ) : (
          <ul className="-my-2 divide-y divide-border">
            {projects.map((project) => (
              <li key={project.id} className="flex items-center justify-between gap-4 py-3">
                <span className="truncate text-sm text-foreground">{project.name}</span>
                <span className="text-xs text-muted-foreground">
                  {project.hasWeb3 ? "Includes Web3" : "Conventional"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Scope, budget and authorization" action={<NotYetActive />}>
        <p className="max-w-2xl text-sm leading-relaxed text-ink-soft">
          Engagement setup isn't switched on yet, so this selection isn't saved and no agent has
          been activated. When it is, you'll complete these steps here:
        </p>
        <ol className="mt-4 space-y-2.5">
          {NEXT_STEPS.map((step) => (
            <li key={step} className="flex items-start gap-2.5 text-sm text-muted-foreground">
              <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" aria-hidden="true" />
              {step}
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}

export default function ConfigureEngagementPage(props: PageProps<"/engagements/new">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ConfigureEngagementContent {...props} />
    </Suspense>
  );
}
