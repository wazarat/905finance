import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-24 text-center">
      <Logo />
      <p className="figure mt-10 text-sm text-brand">404</p>
      <h1 className="mt-3 text-3xl font-semibold text-foreground">This page doesn't exist</h1>
      <p className="mt-3 max-w-md text-muted-foreground">
        The link may be out of date, or the listing may no longer be published.
      </p>
      <div className="mt-8 flex gap-3">
        <Button asChild size="lg" className="h-10 px-4">
          <Link href="/agents">Explore agents</Link>
        </Button>
        <Button asChild variant="outline" size="lg" className="h-10 px-4">
          <Link href="/">Home</Link>
        </Button>
      </div>
    </main>
  );
}
