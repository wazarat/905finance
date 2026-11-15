import { isFindingsReport } from "@/lib/testing";
import { assetLabel } from "@/lib/units";
import { NextResponse, type NextRequest } from "next/server";
import { getActor } from "@/server/auth/actor";
import { isAppError } from "@/server/errors";
import { getTestingReport } from "@/server/testing/reports";

/**
 * The full record of one job as a JSON file: the figures, findings and tool
 * output exactly as stored. Only the buying organization can fetch it.
 */
export async function GET(_request: NextRequest, context: RouteContext<"/reports/[jobId]/evidence">) {
  const { jobId } = await context.params;
  try {
    const report = await getTestingReport(await getActor(), jobId);
    const body = {
      jobId: report.id,
      projectId: report.projectId,
      project: report.projectName,
      fixture: report.fixtureKey,
      sellerId: report.sellerProfileId,
      seller: report.sellerName,
      service: report.offeringName,
      testType: report.capability,
      executionStatus: report.status,
      attempts: report.attempts,
      requestedAt: report.createdAt,
      finishedAt: report.finishedAt,
      failureReason: report.failureReason,
      result: report.result
        ? {
            outcome: report.result.outcome,
            // For a look that lists findings, "failed" is the stored word for "it found something".
            meaning:
              report.result.outcome !== "error" && isFindingsReport(report.result.tool)
                ? "The look ran to completion. It reports findings rather than tests that pass or fail."
                : report.result.outcome === "error"
                  ? "The run could not complete."
                  : "The tests ran to completion.",
            testsExecuted: report.result.testsTotal,
            passed: report.result.testsPassed,
            failed: report.result.testsFailed,
            skipped: report.result.testsSkipped,
            durationMs: report.result.durationMs,
            summary: report.result.summary,
          }
        : null,
      execution: report.execution
        ? {
            tool: report.result?.tool,
            toolVersion: report.execution.toolVersion,
            command: report.execution.command,
            exitCode: report.execution.exitCode,
            error: report.execution.errorMessage,
            workerId: report.execution.workerId,
            reportedAt: report.execution.reportedAt,
            log: report.execution.log,
          }
        : null,
      findings: report.findings.map((finding) => ({
        title: finding.title,
        severity: finding.severity,
        category: finding.category,
        location: finding.location,
        evidence: finding.evidence,
        recommendation: finding.recommendation,
        code: finding.code,
      })),
      usage: {
        charge: report.chargeUnits.toString(),
        asset: assetLabel(report.asset.code),
        assetDecimals: report.asset.decimals,
        paymentReference: report.paymentReference,
        paymentRail: report.paymentRail,
        paymentSimulated: report.isSimulatedPayment,
      },
    };
    return new NextResponse(JSON.stringify(body, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="test-report-${report.id}.json"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (isAppError(error)) {
      const status = error.code === "unauthenticated" ? 401 : error.code === "forbidden" ? 403 : 404;
      return NextResponse.json({ error: error.message }, { status });
    }
    console.error("Evidence download failed", error);
    return NextResponse.json({ error: "The report could not be prepared." }, { status: 500 });
  }
}
