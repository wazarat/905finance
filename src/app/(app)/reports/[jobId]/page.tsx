import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download } from "lucide-react";
import { PageHeader, Panel } from "@/components/app/page-header";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { SimulatedBadge } from "@/components/engagements/badges";
import { ChainLink } from "@/components/goat/chain-link";
import { AutoRefresh } from "@/components/testing/auto-refresh";
import { JobBadge, SeverityBadge, SeverityTally } from "@/components/testing/badges";
import { CodeExcerpt } from "@/components/testing/code-excerpt";
import { Button } from "@/components/ui/button";
import { capabilityLabel, railLabel } from "@/lib/capabilities";
import { FINDING_CATEGORY_LABELS, JOB_STATUS_LABELS, formatDuration, isFindingsReport, toolLabel } from "@/lib/testing";
import { formatUnits } from "@/lib/units";
import { roleHasPermission } from "@/server/authz";
import { isAppError } from "@/server/errors";
import { requireWorkspace } from "@/server/page-context";
import { ProofTag } from "@/components/proofs/proof-tag";
import { Subject } from "@/components/testing/subject";
import { periodLabel } from "@/lib/watch";
import { listProofs } from "@/server/proofs";
import { getTestingReport, type TestingReport } from "@/server/testing/reports";

import { RequeueJobForm } from "./requeue-form";

export const metadata: Metadata = { title: "Test report" };

const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "medium" });

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm break-words text-foreground">{children}</dd>
    </div>
  );
}

function Count({ label, value, tone }: { label: string; value: number | null; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <p className="eyebrow">{label}</p>
      <p className={`figure mt-3 text-3xl ${value === null ? "text-muted-foreground" : (tone ?? "text-foreground")}`}>
        {value ?? "—"}
      </p>
    </div>
  );
}

function headline(report: TestingReport): string {
  if (report.result) return report.result.summary;
  if (report.status === "failed") return report.failureReason ?? "The test did not complete.";
  if (report.status === "running") return "A testing worker is executing this test now.";
  return "This test is paid for and waiting for a testing worker. Nothing has run yet, so there is nothing to report.";
}

async function ReportContent({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const { actor, workspace } = await requireWorkspace();
  const canOperate = roleHasPermission(workspace.role, "engagement.operate");
  let report: TestingReport;
  try {
    report = await getTestingReport(actor, jobId);
  } catch (error) {
    if (isAppError(error) && error.code === "not_found") notFound();
    throw error;
  }
  const { result, execution } = report;
  const reportProof = (await listProofs(actor, workspace.organization.id, "report", [report.id])).get(report.id);
  const pending = report.status === "queued" || report.status === "running";
  const hasCounts = result !== null && result.testsTotal !== null;
  const findingsReport = result !== null && result.outcome !== "error" && isFindingsReport(result.tool);

  return (
    <div className="space-y-8">
      {pending ? <AutoRefresh /> : null}
      <Link
        href={report.watch ? `/watches/${report.watch.id}` : "/reports"}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {report.watch ? "Back to the watch" : "All reports"}
      </Link>

      <PageHeader
        eyebrow={
          report.watch
            ? `Reading ${report.watch.reading + 1} of ${report.watch.readingsPlanned}${report.watch.reading === 0 ? " · first look" : ""} · ${report.projectName}`
            : `${capabilityLabel(report.capability)} · ${report.projectName}`
        }
        title={report.offeringName}
        description={headline(report)}
        actions={
          <>
            <span className="self-center">
              <JobBadge
                status={report.status}
                outcome={result?.outcome}
                tool={result?.tool}
                findings={report.findingsTotal}
              />
            </span>
            {result ? (
              <Button asChild variant="outline" size="lg" className="h-10 px-4">
                <a href={`/reports/${report.id}/evidence`} download>
                  <Download className="size-4" aria-hidden="true" />
                  Download evidence
                </a>
              </Button>
            ) : null}
          </>
        }
      />

      {report.status === "failed" && report.watch ? (
        <div className="rounded-xl border border-warn/30 bg-warn-dim p-5">
          <p className="font-medium text-foreground">This reading was not taken</p>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-soft">
            A reading belongs to its moment, so it is not taken again later. The watch carries on with the next
            one, and its period report will say this reading is missing.
          </p>
        </div>
      ) : report.status === "failed" ? (
        <div className="rounded-xl border border-warn/30 bg-warn-dim p-5">
          <p className="font-medium text-foreground">This test was paid for and did not run</p>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-soft">
            Nothing was delivered for this purchase. You can run it again at no charge: no new purchase
            is made and no payment is touched.
          </p>
          <div className="mt-4">
            {canOperate ? (
              <RequeueJobForm jobId={report.id} />
            ) : (
              <p className="text-sm text-muted-foreground">Owners and admins can run it again.</p>
            )}
          </div>
        </div>
      ) : null}

      {result && findingsReport ? (
        <section aria-label="What was found" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Count label="Findings" value={report.findingsTotal} />
          <Count
            label="Medium or above"
            value={report.findingCounts.critical + report.findingCounts.high + report.findingCounts.medium}
            tone={
              report.findingCounts.critical + report.findingCounts.high > 0
                ? "text-destructive"
                : report.findingCounts.medium > 0
                  ? "text-warn"
                  : "text-foreground"
            }
          />
          <Count label="Low or informational" value={report.findingCounts.low + report.findingCounts.info} />
          <div className="rounded-xl border border-border bg-card p-5">
            <p className="eyebrow">Duration</p>
            <p className="figure mt-3 text-3xl whitespace-nowrap text-foreground">
              {formatDuration(result.durationMs)}
            </p>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground col-span-2 lg:col-span-4">
            {toolLabel(result.tool)} ran to completion. This kind of look reports what it finds rather than tests
            that pass or fail, so findings here mean it did its job.
          </p>
        </section>
      ) : result ? (
        <section aria-label="Test counts" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Count label="Tests executed" value={result.testsTotal} />
          <Count label="Passed" value={result.testsPassed} tone="text-brand" />
          <Count
            label="Failed"
            value={result.testsFailed}
            tone={result.testsFailed ? "text-destructive" : "text-foreground"}
          />
          <div className="rounded-xl border border-border bg-card p-5">
            <p className="eyebrow">Duration</p>
            <p className="figure mt-3 text-3xl whitespace-nowrap text-foreground">
              {formatDuration(result.durationMs)}
            </p>
          </div>
          {!hasCounts && result.outcome !== "error" ? (
            <p className="text-xs leading-relaxed text-muted-foreground col-span-2 lg:col-span-4">
              This kind of job reports findings rather than individual tests, so there are no test
              counts to show.
            </p>
          ) : null}
        </section>
      ) : null}

      <Panel
        title="Findings"
        description={
          result
            ? "Each one was reported by the tool, shown with the code it points at and the tool's own output."
            : "Findings appear once the test has run."
        }
        action={result ? <SeverityTally counts={report.findingCounts} /> : null}
      >
        {!result ? (
          <p className="text-sm text-muted-foreground">Nothing has been reported yet.</p>
        ) : report.findings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {result.outcome === "error"
              ? "The run did not complete, so nothing can be said about the code either way."
              : `${toolLabel(result.tool)} reported no failures for this run.`}
          </p>
        ) : (
          <ol className="-my-5 divide-y divide-border">
            {report.findings.map((finding) => (
              <li key={finding.id} className="space-y-3 py-5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <h3 className="min-w-0 font-medium break-words text-foreground">{finding.title}</h3>
                  <SeverityBadge severity={finding.severity} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {FINDING_CATEGORY_LABELS[finding.category] ?? finding.category}
                  {finding.location ? (
                    <>
                      {" · "}
                      <span className="figure break-all">{finding.location}</span>
                    </>
                  ) : null}
                </p>
                {finding.code ? (
                  <div>
                    <p className="eyebrow">
                      {finding.category === "security"
                        ? "Vulnerable code"
                        : finding.category === "test_failure"
                          ? "Where it fails"
                          : "Code flagged"}
                    </p>
                    <div className="mt-1.5">
                      <CodeExcerpt code={finding.code} tone={finding.category === "test_failure" ? "warn" : "danger"} />
                    </div>
                  </div>
                ) : null}
                {finding.evidence ? (
                  <div>
                    <p className="eyebrow">{finding.code ? "What the tool reported" : "Evidence"}</p>
                    <pre className="figure mt-1.5 max-h-80 overflow-auto rounded-lg border border-border bg-background/60 p-3 text-xs leading-relaxed whitespace-pre-wrap text-ink-soft">
                      {finding.evidence}
                    </pre>
                  </div>
                ) : null}
                {finding.recommendation ? (
                  <div>
                    <p className="eyebrow">Recommendation</p>
                    <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{finding.recommendation}</p>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel title="Job" description="What was run, for whom, and what it cost.">
        <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Job ID">
            <span className="figure break-all">{report.id}</span>
          </Fact>
          <Fact label="Project">
            <Link href={`/projects/${report.projectId}`} className="underline underline-offset-4">
              {report.projectName}
            </Link>
            <span className="block text-xs text-muted-foreground">
              <Subject source={report.source} fixtureKey={report.fixtureKey} />
            </span>
            <span className="figure block text-xs break-all text-muted-foreground">{report.projectId}</span>
          </Fact>
          <Fact label="Seller">
            {report.sellerName}
            <span className="figure block text-xs break-all text-muted-foreground">
              {report.sellerProfileId}
            </span>
          </Fact>
          <Fact label="Test type">{capabilityLabel(report.capability)}</Fact>
          <Fact label="Execution status">
            {JOB_STATUS_LABELS[report.status]}
            {report.attempts > 1 ? (
              <span className="block text-xs text-muted-foreground">Attempt {report.attempts}</span>
            ) : null}
          </Fact>
          <Fact label="Engagement">
            <Link href={`/engagements/${report.engagementId}`} className="underline underline-offset-4">
              View engagement
            </Link>
          </Fact>
          <Fact label={report.watch ? "Charge for the whole watch" : "Usage charge"}>
            <span className="figure">{formatUnits(report.chargeUnits, report.asset)}</span>
            {report.isSimulatedPayment ? <SimulatedBadge className="ml-2" /> : null}
            {report.watch ? (
              <span className="block text-xs text-muted-foreground">
                One payment covers all {report.watch.readingsPlanned} readings over {periodLabel(report.watch.periodDays)}.{" "}
                <Link href={`/watches/${report.watch.id}`} className="underline underline-offset-4">
                  View the watch
                </Link>
              </span>
            ) : null}
          </Fact>
          <Fact label="Payment reference">
            {report.paymentReference ? <ChainLink value={report.paymentReference} /> : "None"}
            {report.paymentRail ? (
              <span className="block text-xs text-muted-foreground">{railLabel(report.paymentRail)}</span>
            ) : null}
          </Fact>
          {reportProof ? (
            <Fact label="Proof of this report">
              <ProofTag proof={reportProof} />
            </Fact>
          ) : null}
          <Fact label="Requested">{dateTimeFormat.format(report.createdAt)}</Fact>
          {report.finishedAt ? <Fact label="Finished">{dateTimeFormat.format(report.finishedAt)}</Fact> : null}
          {execution ? (
            <>
              <Fact label="Tool">
                {toolLabel(result?.tool ?? "")}
                {execution.toolVersion ? (
                  <span className="figure block text-xs break-all text-muted-foreground">
                    {execution.toolVersion}
                  </span>
                ) : null}
              </Fact>
              <Fact label="Command">
                <span className="figure break-all">{execution.command || "None"}</span>
                {execution.exitCode !== null ? (
                  <span className="block text-xs text-muted-foreground">Exit code {execution.exitCode}</span>
                ) : null}
              </Fact>
              <Fact label="Testing worker">
                <span className="figure break-all">{execution.workerId}</span>
              </Fact>
            </>
          ) : null}
        </dl>
        {report.isSimulatedPayment ? (
          <p className="mt-5 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
            The test execution is real. The payment was made in test funds: no real asset moved.
          </p>
        ) : null}
      </Panel>

      {execution ? (
        <Panel
          title="Tool output"
          description={`${toolLabel(result?.tool ?? "")}'s output for this run, kept as evidence.`}
        >
          {execution.log ? (
            <pre className="figure max-h-[32rem] overflow-auto rounded-lg border border-border bg-background/60 p-4 text-xs leading-relaxed whitespace-pre-wrap text-ink-soft">
              {execution.log}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">The tool printed nothing.</p>
          )}
        </Panel>
      ) : null}
    </div>
  );
}

export default function ReportPage({ params }: PageProps<"/reports/[jobId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ReportContent params={params} />
    </Suspense>
  );
}
