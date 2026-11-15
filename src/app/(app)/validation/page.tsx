import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, PageHeader, Panel } from "@/components/app/page-header";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { CaseStatusBadge, Stars } from "@/components/reputation/stars";
import { isAppError } from "@/server/errors";
import { requireWorkspace } from "@/server/page-context";
import { listCasesForOperator, type CaseSummary } from "@/server/reputation";

export const metadata: Metadata = { title: "Validation" };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

async function QueueContent() {
  const { actor } = await requireWorkspace();
  let cases: CaseSummary[];
  try {
    cases = await listCasesForOperator(actor);
  } catch (error) {
    if (isAppError(error)) notFound();
    throw error;
  }
  const open = cases.filter((entry) => entry.status === "open").length;
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="905 Finance"
        title="Validation"
        description="Problems buyers have reported, and ratings of one or two stars. Each is decided once, by someone on neither side."
      />
      <Panel title="Cases" description={open === 1 ? "1 waiting for a verdict." : `${open} waiting for a verdict.`}>
        {cases.length === 0 ? (
          <EmptyState title="Nothing to review" body="Cases appear here when a buyer reports a problem or gives a low rating." />
        ) : (
          <ul className="-my-4 divide-y divide-border">
            {cases.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-4">
                <div className="min-w-0">
                  <Link
                    href={`/validation/${entry.id}`}
                    className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
                  >
                    {entry.buyerName} about {entry.sellerName}
                  </Link>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{entry.origin === "low_rating" ? "Low rating" : "Reported problem"}</span>
                    {entry.stars ? <Stars stars={entry.stars} /> : null}
                    <span>Opened {dateFormat.format(entry.createdAt)}</span>
                    {entry.score !== null ? <span className="figure">Score {entry.score} / 100</span> : null}
                  </p>
                </div>
                <CaseStatusBadge status={entry.status} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

export default function ValidationPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <QueueContent />
    </Suspense>
  );
}
