import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { SellerDetail } from "@/components/sellers/seller-detail";
import { requireWorkspace } from "@/server/page-context";
import { getSellerPreview } from "@/server/sellers";

export const metadata: Metadata = { title: "Listing preview" };

async function ListingPreviewContent() {
  const { actor, workspace } = await requireWorkspace();
  const seller = await getSellerPreview(actor, workspace.organization.id);
  if (!seller) redirect("/seller/listing");

  return (
    <div className="space-y-8">
      <Link
        href="/seller/listing"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to editing
      </Link>
      <div className="rounded-xl border border-info/25 bg-info-dim px-5 py-3 text-sm text-ink-soft">
        <span className="font-medium text-foreground">Preview.</span> This is how buyers will see
        your listing once it's active. Your endpoint address is never shown.
      </div>
      <SellerDetail seller={seller} showStatus />
    </div>
  );
}

export default function ListingPreviewPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ListingPreviewContent />
    </Suspense>
  );
}
