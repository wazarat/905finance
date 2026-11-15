import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { Check, Circle, Eye } from "lucide-react";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { PageHeader, Panel } from "@/components/app/page-header";
import { ListingStatusBadge } from "@/components/sellers/badges";
import { Button } from "@/components/ui/button";
import { BILLING_UNIT_LABELS, capabilityLabel } from "@/lib/capabilities";
import { formatMoney } from "@/lib/money";
import { roleHasPermission } from "@/server/authz";
import { requireWorkspace } from "@/server/page-context";
import { getSellerListing, listingGaps } from "@/server/sellers";
import { EnableRoleForm } from "../../enable-role-form";
import {
  AddOfferingForm,
  EndpointForm,
  ListingProfileForm,
  RemoveOfferingButton,
  SubmitListingForm,
  WithdrawListingForm,
} from "./listing-forms";

import { ChainLink } from "@/components/goat/chain-link";
import { agentExplorerLink } from "@/lib/goat";
import { getOwnSellerIdentity } from "@/server/identity";
import { IdentityControls, LinkIdentityForm } from "./identity-forms";

export const metadata: Metadata = { title: "Listing" };

const REQUIREMENTS = [
  "Write a description of at least 40 characters.",
  "Select at least one capability.",
  "Add at least one priced service offering.",
  "Link a service endpoint.",
] as const;

async function SellerListingContent() {
  const { actor, workspace } = await requireWorkspace();
  const listing = await getSellerListing(actor, workspace.organization.id);

  if (!listing) {
    return (
      <div className="space-y-8">
        <PageHeader
          eyebrow="Selling"
          title="Start selling"
          description="Add the seller role to create a listing for your agent. It starts as a private draft."
        />
        {workspace.role === "owner" ? (
          <EnableRoleForm role="seller" label="Create a seller listing" />
        ) : (
          <p className="text-sm text-muted-foreground">Ask your organization's owner to enable selling.</p>
        )}
      </div>
    );
  }

  const { profile, offerings, endpoint } = listing;
  const identity = await getOwnSellerIdentity(actor, workspace.organization.id);
  const canManage = roleHasPermission(workspace.role, "seller_listing.manage");
  const locked = profile.status === "suspended" || profile.status === "pending_review";
  const canEdit = canManage && !locked;
  const gaps = listingGaps(listing);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Selling"
        title="Listing"
        description="What buyers see when they browse the marketplace. Save as often as you like; nothing is public until the listing is activated."
        actions={
          <Button asChild variant="outline" size="lg" className="h-10 px-4">
            <Link href="/seller/listing/preview">
              <Eye data-icon="inline-start" aria-hidden="true" />
              Preview
            </Link>
          </Button>
        }
      />

      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <ListingStatusBadge status={profile.status} />
            <span className="figure text-xs text-muted-foreground">/agents/{profile.slug}</span>
          </div>
          <p className="max-w-xl text-sm leading-relaxed text-ink-soft">
            {profile.status === "draft"
              ? "Draft. Only your organization can see this listing."
              : profile.status === "pending_review"
                ? "Submitted and awaiting activation by 905 Finance. Withdraw it to make changes."
                : profile.status === "active"
                  ? "Live in the marketplace. Edits you save appear to buyers immediately."
                  : "Suspended. This listing is hidden from buyers and cannot be edited."}
          </p>
          {!canManage ? (
            <p className="text-sm text-muted-foreground">
              You have read-only access. Owners and admins can edit the listing.
            </p>
          ) : null}
        </div>
        {canManage && profile.status === "pending_review" ? <WithdrawListingForm /> : null}
      </div>

      <Panel title="Profile" description="Name, description and capabilities.">
        <ListingProfileForm
          canEdit={canEdit}
          initial={{
            displayName: profile.displayName,
            tagline: profile.tagline,
            description: profile.description,
            capabilities: profile.capabilities,
          }}
        />
      </Panel>

      <Panel title="Service offerings" description="Each offering is a priced, pay-per-use service.">
        {offerings.length > 0 ? (
          <ul className="mb-6 divide-y divide-border rounded-lg border border-border">
            {offerings.map((offering) => (
              <li key={offering.id} className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{offering.name}</p>
                  <p className="truncate text-sm text-muted-foreground">
                    {capabilityLabel(offering.capability)}
                    {offering.description ? ` · ${offering.description}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <div className="text-right">
                    <p className="figure text-foreground">
                      {formatMoney(offering.priceMinor, offering.currency)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {BILLING_UNIT_LABELS[offering.billingUnit]}
                    </p>
                  </div>
                  {canEdit ? <RemoveOfferingButton offeringId={offering.id} name={offering.name} /> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-6 text-sm text-muted-foreground">No offerings yet. Add your first one below.</p>
        )}
        {canEdit ? <AddOfferingForm /> : null}
      </Panel>

      <Panel title="Service endpoint" description="Where an authorized buyer agent reaches your agent.">
        <EndpointForm
          canEdit={canEdit}
          initial={{ url: endpoint?.url ?? "", protocol: endpoint?.protocol ?? "https_json" }}
        />
      </Panel>

      <Panel
        title="ERC-8004 identity"
        description="Your agent's on-chain identity on GOAT Testnet3. It is where buyers see who you are and where you are paid."
      >
        {identity?.identity ? (
          <div className="space-y-5">
            <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Agent</dt>
                <dd className="mt-0.5">
                  <a
                    href={agentExplorerLink(identity.identity.agentId)}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
                  >
                    Agent {identity.identity.agentId}
                  </a>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Status</dt>
                <dd className={identity.identity.confirmed ? "mt-0.5 text-brand" : "mt-0.5 text-warn"}>
                  {identity.identity.confirmed ? "Confirmed by its registration" : "Unconfirmed claim"}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground">Registered owner</dt>
                <dd className="mt-0.5">
                  <ChainLink value={identity.identity.ownerAddress} />
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground">Receiving wallet</dt>
                <dd className="mt-0.5">
                  <ChainLink value={identity.identity.agentWallet} />
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {identity.identity.agentWalletSet
                      ? "Set in the registry."
                      : "No wallet is set in the registry, so the owner stands in."}
                  </span>
                </dd>
              </div>
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-muted-foreground">Registration document</dt>
                <dd className="figure mt-0.5 text-xs break-all text-ink-soft">
                  {identity.identity.agentUri || "None"}
                  {identity.identity.registrationProblem ? (
                    <span className="mt-0.5 block font-sans text-sm text-warn">
                      {identity.identity.registrationProblem}
                    </span>
                  ) : null}
                </dd>
              </div>
            </dl>
            {!identity.identity.confirmed ? (
              <div className="rounded-lg border border-warn/30 bg-warn-dim p-4 text-sm leading-relaxed text-ink-soft">
                <p className="font-medium text-foreground">Not confirmed yet</p>
                <p className="mt-1">
                  Anyone can type an agent id, so a link counts only when the agent points back. Add
                  this listing to the <code className="figure">services</code> of the agent&apos;s
                  registration document, make sure its <code className="figure">registrations</code>{" "}
                  entry names this registry and agent id, then choose Read again. Until then buyers
                  see an unconfirmed claim and the wallet above is not used for payment.
                </p>
                <pre className="figure mt-3 overflow-x-auto rounded-md border border-border bg-background/60 p-3 text-xs text-ink-soft">
                  {JSON.stringify({ name: "905finance", endpoint: identity.listingUrl }, null, 2)}
                </pre>
                <p className="mt-3">
                  Or, more simply, set the agent&apos;s registration on GOAT to this listing&apos;s own document,
                  which 905 Finance serves and keeps up to date:
                </p>
                <p className="figure mt-2 text-xs break-all text-foreground select-all">{identity.registrationUrl}</p>
              </div>
            ) : null}
            {canManage ? (
              <div className="grid gap-6 border-t border-border pt-5 sm:grid-cols-2">
                <IdentityControls />
                <LinkIdentityForm currentAgentId={identity.identity.agentId} />
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="max-w-2xl text-sm leading-relaxed text-ink-soft">
              Not linked. Register your agent in the ERC-8004 Identity Registry on GOAT Testnet3,
              then enter its id here. The owner, the receiving wallet and the registration are read
              from the chain; nothing else is typed in. Registering is done from your own wallet,
              not by 905 Finance.
            </p>
            {identity ? (
              <div>
                <p className="text-xs text-muted-foreground">
                  A registration document for this listing, ready to use as the agent&apos;s registration
                </p>
                <p className="figure mt-1 text-xs break-all text-foreground select-all">{identity.registrationUrl}</p>
              </div>
            ) : null}
            {canManage ? (
              <LinkIdentityForm currentAgentId={null} />
            ) : (
              <p className="text-sm text-muted-foreground">Owners and admins can link an identity.</p>
            )}
          </div>
        )}
      </Panel>

      {profile.status === "draft" ? (
        <Panel
          title="Submit for activation"
          description="905 Finance reviews submissions before they appear in the marketplace."
        >
          <ul className="mb-5 space-y-2">
            {REQUIREMENTS.map((requirement) => {
              const done = !gaps.includes(requirement);
              return (
                <li key={requirement} className="flex items-start gap-2.5 text-sm">
                  {done ? (
                    <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
                  ) : (
                    <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                  <span className={done ? "text-muted-foreground line-through" : "text-ink-soft"}>
                    {requirement}
                  </span>
                  <span className="sr-only">{done ? "(done)" : "(to do)"}</span>
                </li>
              );
            })}
          </ul>
          {canManage ? (
            <SubmitListingForm ready={gaps.length === 0} />
          ) : (
            <p className="text-sm text-muted-foreground">Owners and admins can submit the listing.</p>
          )}
        </Panel>
      ) : null}
    </div>
  );
}

export default function SellerListingPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <SellerListingContent />
    </Suspense>
  );
}
