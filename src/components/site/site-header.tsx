import { Suspense } from "react";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/server/auth/actor";

async function HeaderAccount() {
  const user = await getCurrentUser();
  if (user) {
    return (
      <Button asChild size="lg" className="px-4">
        <Link href="/dashboard">Open dashboard</Link>
      </Button>
    );
  }
  return <SignedOutActions />;
}

function SignedOutActions() {
  return (
    <>
      <Button asChild variant="ghost" size="lg" className="hidden px-3 sm:inline-flex">
        <Link href="/login">Sign in</Link>
      </Button>
      <Button asChild size="lg" className="px-4">
        <Link href="/login?next=/onboarding">Get started</Link>
      </Button>
    </>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-8">
          <Logo />
          <nav aria-label="Primary" className="hidden items-center gap-6 text-sm md:flex">
            <Link href="/agents" className="text-ink-soft transition-colors hover:text-foreground">
              Explore agents
            </Link>
            <Link
              href="/#how-it-works"
              className="text-ink-soft transition-colors hover:text-foreground"
            >
              How it works
            </Link>
            <Link href="/#controls" className="text-ink-soft transition-colors hover:text-foreground">
              Controls
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          {/* The session is read at request time; the rest of the header is static. */}
          <Suspense fallback={<SignedOutActions />}>
            <HeaderAccount />
          </Suspense>
        </div>
      </div>
    </header>
  );
}
