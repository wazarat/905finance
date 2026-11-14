import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader, Panel } from "@/components/app/page-header";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { CapabilityChip, SampleBadge } from "@/components/sellers/badges";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/money";
import { roleHasPermission } from "@/server/authz";
import { getPublicSellerBySlug } from "@/server/marketplace";
import { requireWorkspace } from "@/server/page-context";
import { listProjects } from "@/server/projects";
import { EnableRoleForm } from "../../enable-role-form";
import { CreateEngagementForm } from "./create-engagement-form";

export const metadata: Metadata = { title: "New engagement" };

/**
 * Reached from "Select this seller". Confirms the human-made selection and
 * asks which project it is for. Nothing is contacted, provisioned or spent.
 */
async function NewEngagementContent({ searchParams }: PageProps<"/engagements/new">) {
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

  if (!workspace.buyerProfile) {
    return (
      <div className="space-y-8">
        <PageHeader
          eyebrow="Engagement"
          title="Enable buying to hire an agent"
          description={`Your organization currently only sells. Add the buyer role to engage ${seller.displayName}.`}
        />
        {workspace.role === "owner" ? (
          <EnableRoleForm role="buyer" label="Enable buying" />
        ) : (
          <p className="text-sm text-muted-foreground">Ask your organization&apos;s owner to enable buying.</p>
        )}
      </div>
    );
  }

  const projects = await listProjects(actor, workspace.organization.id);
  const canDraft = roleHasPermission(workspace.role, "engagement.draft");

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
        title="New engagement"
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

      <Panel title="Project" description="The software this engagement covers.">
        {projects.length === 0 ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              You don&apos;t have a project yet. Create one, then come back to this seller.
            </p>
            <Button asChild variant="outline" size="lg" className="h-10 px-4">
              <Link href="/projects/new">New project</Link>
            </Button>
          </div>
        ) : canDraft ? (
          <CreateEngagementForm
            sellerSlug={seller.slug}
            sellerName={seller.displayName}
            projects={projects.map((p) => ({ id: p.id, name: p.name, hasWeb3: p.hasWeb3 }))}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Owners and admins can create engagements.</p>
        )}
      </Panel>
    </div>
  );
}

export default function NewEngagementPage(props: PageProps<"/engagements/new">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <NewEngagementContent {...props} />
    </Suspense>
  );
}
