import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader, Panel } from "@/components/app/page-header";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { CaseStatusBadge, Stars } from "@/components/reputation/stars";
import { SeverityBadge } from "@/components/testing/badges";
import { capabilityLabel } from "@/lib/capabilities";
import { JOB_STATUS_LABELS, OUTCOME_LABELS, toolLabel, type Severity } from "@/lib/testing";
import { isAppError } from "@/server/errors";
import { requireWorkspace } from "@/server/page-context";
import { getCaseForOperator, type CaseDetail } from "@/server/reputation";
import { DecideForm } from "./decide-form";

export const metadata: Metadata = { title: "Case" };

const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

async function CaseContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor } = await requireWorkspace();
  let detail: CaseDetail;
  try {
    detail = await getCaseForOperator(actor, id);
  } catch (error) {
    if (isAppError(error)) notFound();
    throw error;
  }
  return (
    <div className="space-y-8">
      <Link href="/validation" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" /> All cases
      </Link>
      <PageHeader
        eyebrow={detail.origin === "low_rating" ? "Low rating" : "Reported problem"}
        title={`${detail.buyerName} about ${detail.sellerName}`}
        description={`Opened ${dateTimeFormat.format(detail.createdAt)}.`}
        actions={<CaseStatusBadge status={detail.status} />}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="The buyer" description={detail.buyerName}>
          <div className="space-y-3">
            {detail.stars ? (
              <p className="flex items-center gap-2 text-sm text-foreground">
                <Stars stars={detail.stars} /> {detail.stars} of 5
              </p>
            ) : null}
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-soft">{detail.reason}</p>
            {detail.comment && detail.comment !== detail.reason ? (
              <div>
                <p className="eyebrow">Comment with the rating</p>
                <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-ink-soft">{detail.comment}</p>
              </div>
            ) : null}
          </div>
        </Panel>
        <Panel title="The seller" description={detail.sellerName}>
          {detail.sellerResponse ? (
            <div className="space-y-2">
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-soft">{detail.sellerResponse}</p>
              {detail.sellerRespondedAt ? (
                <p className="text-xs text-muted-foreground">Replied {dateTimeFormat.format(detail.sellerRespondedAt)}</p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">The seller has not replied.</p>
          )}
        </Panel>
      </div>

      <Panel
        title="What the tests recorded"
        description="Taken from the testing worker's reports for this engagement. Nothing here was written by either side."
      >
        {detail.evidence.length === 0 ? (
          <p className="text-sm text-muted-foreground">No test was run under this engagement.</p>
        ) : (
          <ul className="-my-4 divide-y divide-border">
            {detail.evidence.map((job) => (
              <li key={job.jobId} className="space-y-2 py-4">
                <p className="text-sm font-medium text-foreground">
                  {capabilityLabel(job.capability)}
                  <span className="font-normal text-muted-foreground">
                    {" · "}
                    {job.outcome
                      ? `${OUTCOME_LABELS[job.outcome as keyof typeof OUTCOME_LABELS] ?? job.outcome}, ${toolLabel(job.tool ?? "")}`
                      : (JOB_STATUS_LABELS[job.status as keyof typeof JOB_STATUS_LABELS] ?? job.status)}
                  </span>
                </p>
                {job.testsTotal !== null ? (
                  <p className="figure text-xs text-muted-foreground">
                    {job.testsTotal} tests: {job.testsPassed} passed, {job.testsFailed} failed
                  </p>
                ) : null}
                {job.errorMessage ? <p className="text-sm text-warn">{job.errorMessage}</p> : null}
                {job.findings.length > 0 ? (
                  <ul className="space-y-1.5">
                    {job.findings.map((finding, index) => (
                      <li key={index} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-soft">
                        <SeverityBadge severity={finding.severity as Severity} />
                        <span className="min-w-0 break-words">{finding.title}</span>
                        {finding.location ? (
                          <span className="figure text-xs break-all text-muted-foreground">{finding.location}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Verdict" description="Decided once, in 905 Finance's name.">
        {detail.status !== "open" ? (
          <div className="space-y-2">
            <p className="text-sm text-foreground">
              Score for the seller&apos;s work: <span className="figure">{detail.score} / 100</span>
              {detail.decidedAt ? (
                <span className="text-muted-foreground"> · {dateTimeFormat.format(detail.decidedAt)}</span>
              ) : null}
            </p>
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-soft">{detail.verdictNote}</p>
          </div>
        ) : detail.conflicted ? (
          <p className="text-sm leading-relaxed text-warn">
            You belong to one of the two organizations in this case, so you cannot decide it. Another 905 Finance
            validator has to.
          </p>
        ) : (
          <DecideForm caseId={detail.id} />
        )}
        <p className="figure mt-5 border-t border-border pt-4 text-xs break-all text-muted-foreground">
          Request hash {detail.requestHash}
        </p>
      </Panel>
    </div>
  );
}

export default function CasePage({ params }: PageProps<"/validation/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <CaseContent params={params} />
    </Suspense>
  );
}
