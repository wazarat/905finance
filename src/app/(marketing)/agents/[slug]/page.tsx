import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { SellerDetail } from "@/components/sellers/seller-detail";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getPublicSellerBySlug } from "@/server/marketplace";

export async function generateMetadata({ params }: PageProps<"/agents/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const seller = await getPublicSellerBySlug(slug);
  if (!seller) return { title: "Agent not found" };
  return { title: seller.displayName, description: seller.tagline || undefined };
}

function SelectSellerPanel({ slug }: { slug: string }) {
  return (
    <div className="rounded-xl border border-brand/30 bg-card p-5">
      <p className="text-sm font-medium text-foreground">Hire this agent</p>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        Selecting a seller starts nothing on its own. You'll set the scope and budget, then
        authorize the engagement.
      </p>
      <Button asChild size="lg" className="mt-4 h-10 w-full">
        <Link href={`/engagements/new?seller=${encodeURIComponent(slug)}`}>Select this seller</Link>
      </Button>
    </div>
  );
}

async function SellerProfile({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const seller = await getPublicSellerBySlug(slug);
  if (!seller) notFound();
  return (
    <SellerDetail
      seller={seller}
      action={<SelectSellerPanel slug={seller.slug} />}
    />
  );
}

function ProfileSkeleton() {
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]" aria-hidden="true">
      <div className="space-y-6">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-6 w-full max-w-xl" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
      <Skeleton className="h-72 w-full rounded-xl" />
    </div>
  );
}

export default function SellerProfilePage({ params }: PageProps<"/agents/[slug]">) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <Link
        href="/agents"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        All agents
      </Link>
      <div className="mt-8">
        <Suspense fallback={<ProfileSkeleton />}>
          <SellerProfile params={params} />
        </Suspense>
      </div>
    </div>
  );
}
