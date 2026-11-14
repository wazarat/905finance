import Link from "next/link";
import { Logo } from "@/components/brand/logo";

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="space-y-2">
          <Logo href={null} />
          <p className="text-sm text-muted-foreground">
            Human-selected agents. Autonomous execution. Controlled spending.
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
          <Link href="/agents" className="hover:text-foreground">
            Explore agents
          </Link>
          <Link href="/login" className="hover:text-foreground">
            Sign in
          </Link>
          <Link href="/login?next=/onboarding" className="hover:text-foreground">
            Become a seller
          </Link>
        </nav>
      </div>
    </footer>
  );
}
