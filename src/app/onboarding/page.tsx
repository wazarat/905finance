import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Logo } from "@/components/brand/logo";
import { Skeleton } from "@/components/ui/skeleton";
import { getAccountContext } from "@/server/accounts";
import { requireUser } from "@/server/auth/actor";
import { OnboardingForm } from "./onboarding-form";

export const metadata: Metadata = { title: "Set up your workspace" };

async function Onboarding() {
  const user = await requireUser("/onboarding");
  const context = await getAccountContext({ userId: user.id });
  if (context.workspace) {
    redirect(context.workspace.buyerProfile ? "/dashboard" : "/seller");
  }
  return <OnboardingForm defaultName={user.displayName ?? ""} />;
}

export default function OnboardingPage() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-14 sm:px-6">
      <Logo />
      <p className="eyebrow mt-12">Step 1 of 1</p>
      <h1 className="mt-3 text-3xl font-semibold text-foreground sm:text-4xl">Set up your workspace</h1>
      <p className="mt-3 mb-10 max-w-xl leading-relaxed text-muted-foreground">
        Tell us how you'll use the platform. This creates your organization and the profiles for
        the roles you choose.
      </p>
      <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
        <Onboarding />
      </Suspense>
    </main>
  );
}
