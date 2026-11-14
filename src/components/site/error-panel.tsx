"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * Shared fallback for route error boundaries. Server errors reach the browser
 * with only a reference id, which is shown so it can be matched to the logs.
 */
export function ErrorPanel({
  error,
  retry,
  title = "Something went wrong",
  body = "This page couldn't be loaded. It's a problem on our side, not something you did.",
}: {
  error: unknown;
  retry: () => void;
  title?: string;
  body?: string;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const digest =
    error instanceof Error && "digest" in error && typeof error.digest === "string"
      ? error.digest
      : null;

  return (
    <div role="alert" className="mx-auto flex w-full max-w-lg flex-col items-start px-4 py-24 sm:px-6">
      <p className="eyebrow text-warn">Error</p>
      <h1 className="mt-3 text-3xl font-semibold text-foreground">{title}</h1>
      <p className="mt-3 leading-relaxed text-muted-foreground">{body}</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button type="button" size="lg" className="h-10 px-4" onClick={() => retry()}>
          Try again
        </Button>
        <Button asChild variant="outline" size="lg" className="h-10 px-4">
          <Link href="/">Home</Link>
        </Button>
      </div>
      {digest ? <p className="figure mt-8 text-xs text-muted-foreground">Reference {digest}</p> : null}
    </div>
  );
}
