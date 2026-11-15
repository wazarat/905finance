import type { Metadata } from "next";
import { Suspense } from "react";
import { EmptyState, PageHeader, Panel } from "@/components/app/page-header";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { PAYMENT_RAILS } from "@/lib/capabilities";
import { formatUnits } from "@/lib/units";
import { roleHasPermission } from "@/server/authz";
import { listAuditEvents, type AuditLine } from "@/server/audit-log";
import { goatLiveConfig } from "@/server/goat/live";
import { requireWorkspace } from "@/server/page-context";

export const metadata: Metadata = { title: "Activity log" };

const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "medium" });

/** Plain descriptions of the actions that are recorded. An unknown action is shown as recorded. */
const ACTIONS: Record<string, string> = {
  "organization.created": "Created the organization",
  "buyer_profile.created": "Enabled buying",
  "seller_profile.created": "Created a seller listing",
  "seller_profile.updated": "Edited the seller listing",
  "seller_profile.submitted": "Submitted the listing for activation",
  "seller_profile.withdrawn": "Withdrew the listing from review",
  "service_endpoint.saved": "Saved the seller endpoint",
  "service_offering.created": "Added a service offering",
  "service_offering.deleted": "Removed a service offering",
  "service_offering.retired": "Retired a service offering",
  "seller_identity.linked": "Linked an ERC-8004 identity",
  "seller_identity.unlinked": "Unlinked the ERC-8004 identity",
  "project.created": "Created a project",
  "project.deleted": "Deleted a project",
  "engagement.seller_selected": "Selected a seller",
  "mandate.drafted": "Saved a draft mandate",
  "engagement.authorized": "Authorized an engagement and its mandate",
  "engagement_wallet.provisioned": "Provisioned an engagement wallet",
  "master_wallet.simulated_deposit": "Added funds",
  "funding.authorized": "Authorized funding",
  "funding.failed": "Funding failed; no funds moved",
  "purchase.blocked": "A purchase was blocked",
  "payment.confirmed": "A payment was confirmed",
  "payment.failed": "A payment failed; nothing was charged",
  "payment.uncertain": "A payment's outcome is unknown",
  "approval.requested": "An agent asked for a decision",
  "mandate.budget_increased": "Approved a higher budget",
  "approval.rejected": "Declined an agent's request",
  "approval.modified": "Chose different work for the agent",
  "engagement.completed": "Completed an engagement",
  "engagement.cancelled": "Cancelled an engagement",
  "engagement.expired": "An engagement reached its deadline",
  "engagement.failed": "An engagement failed",
  "funds.returned": "Returned unused funds",
  "buyer_identity.linked": "Linked the buying agent's ERC-8004 identity",
  "buyer_identity.unlinked": "Unlinked the buying agent's ERC-8004 identity",
  "rating.given": "Rated a seller",
  "validation.opened": "Put a problem to 905 Finance",
  "validation.seller_responded": "Replied to a case under review",
  "validation.decided": "905 Finance decided a case",
  "testing_job.requeued": "Ran a failed test again",
  "qatom.connected": "Linked a Qatom account",
  "qatom.disconnected": "Unlinked the Qatom account",
};

/** An amount as people read it, when the asset's precision is known; otherwise the raw units, labelled as such. */
function amountOf(asset: string, units: string): string {
  if (!asset || !/^\d+$/.test(units)) return "";
  const known = PAYMENT_RAILS.find((rail) => rail.simulatedAsset.code === asset)?.simulatedAsset;
  const token = goatLiveConfig()?.token;
  const decimals = known?.decimals ?? (token && token.symbol.toLowerCase() === asset.toLowerCase() ? token.decimals : null);
  return decimals === null ? `${units} units of ${asset}` : formatUnits(BigInt(units), { code: asset, decimals });
}

/** The few details worth showing, chosen by name. Nothing secret is ever written to this log. */
function detail(line: AuditLine): string {
  const data = line.metadata;
  const text = (key: string) => (typeof data[key] === "string" || typeof data[key] === "number" ? String(data[key]) : "");
  const parts = [
    text("name"),
    amountOf(text("asset"), text("amountUnits")),
    text("agentId") ? `agent ${text("agentId")}` : "",
    typeof data.stars === "number" ? `${data.stars} of 5 stars` : "",
    text("verdict") ? (text("verdict") === "upheld" ? "complaint upheld" : "complaint not upheld") : "",
    text("reason"),
    data.simulated === true ? "test funds" : data.simulated === false ? "on GOAT Testnet3" : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

async function AuditContent() {
  const { actor, workspace } = await requireWorkspace();
  if (!roleHasPermission(workspace.role, "audit.view")) {
    return (
      <PageHeader
        eyebrow="Account"
        title="Activity log"
        description="The record of sensitive actions is available to the organization's owners and admins."
      />
    );
  }
  const events = await listAuditEvents(actor, workspace.organization.id);
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Account"
        title="Activity log"
        description="Every sensitive action in your organization: who authorized, funded, approved, linked or ended what, and when. Entries are added, never edited or removed."
      />
      <Panel title="Recorded actions" description="Newest first.">
        {events.length === 0 ? (
          <EmptyState title="Nothing recorded yet" body="Actions appear here as they happen." />
        ) : (
          <ol className="-my-3 divide-y divide-border">
            {events.map((event) => {
              const extra = detail(event);
              return (
                <li key={event.id} className="grid gap-1 py-3 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-4">
                  <span className="figure text-xs text-muted-foreground">{dateTimeFormat.format(event.createdAt)}</span>
                  <span className="min-w-0 text-sm">
                    <span className="text-foreground">{ACTIONS[event.action] ?? event.action}</span>
                    <span className="text-muted-foreground"> · {event.actorName ?? "905 Finance"}</span>
                    {extra ? <span className="mt-0.5 block text-xs break-words text-muted-foreground">{extra}</span> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </Panel>
    </div>
  );
}

export default function AuditPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AuditContent />
    </Suspense>
  );
}
