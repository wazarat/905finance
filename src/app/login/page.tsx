import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PrivyBoundary } from "@/components/auth/privy-boundary";
import { PrivyLogin } from "@/components/auth/privy-login";
import { Logo } from "@/components/brand/logo";
import { Skeleton } from "@/components/ui/skeleton";
import { safeNextPath } from "@/lib/paths";
import { getCurrentUser } from "@/server/auth/actor";
import { getAuthAvailability } from "@/server/auth/config";
import { DevSignInForm } from "./dev-sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

async function LoginPanel({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawNext = Array.isArray(params.next) ? params.next[0] : params.next;
  const next = safeNextPath(rawNext);

  const user = await getCurrentUser();
  if (user) redirect(user.onboardedAt ? next : "/onboarding");

  const { privyAppId, devSignIn } = getAuthAvailability();

  return (
    <div className="space-y-6">
      {privyAppId ? (
        <PrivyBoundary appId={privyAppId}>
          <PrivyLogin next={next} />
        </PrivyBoundary>
      ) : null}

      {devSignIn ? (
        <div className="rounded-xl border border-warn/30 bg-warn-dim p-5">
          <p className="eyebrow text-warn">Development sign-in</p>
          <p className="mt-2 mb-4 text-sm leading-relaxed text-ink-soft">
            Local only. Signs you in as any email without a password so the app can be used before
            Privy is configured. Disabled in production.
          </p>
          <DevSignInForm next={next} />
        </div>
      ) : null}

      {!privyAppId && !devSignIn ? (
        <div role="alert" className="rounded-xl border border-border bg-card p-5">
          <p className="text-sm font-medium text-foreground">Sign-in isn't configured yet</p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Sign-in opens once the site's authentication settings are in place. You can still
            browse the marketplace.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm">
        <Logo />
        <h1 className="mt-10 text-3xl font-semibold text-foreground">Sign in</h1>
        <p className="mt-2 mb-8 text-muted-foreground">
          One account for buying and selling. New here? Signing in creates your account.
        </p>
        <Suspense fallback={<Skeleton className="h-11 w-full rounded-lg" />}>
          <LoginPanel searchParams={searchParams} />
        </Suspense>
        <p className="mt-8 text-sm text-muted-foreground">
          Just looking?{" "}
          <Link href="/agents" className="text-foreground underline underline-offset-4">
            Explore agents
          </Link>{" "}
          without an account.
        </p>
      </div>
    </main>
  );
}
